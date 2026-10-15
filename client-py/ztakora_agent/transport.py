import gzip
import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import ssl

from .errors import ClientError

PIN_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_READ_CHUNK = 262144

# Only a failure to reach a listener moves on: no response arrived, so the collector's router never
# saw the request and trying the next port cannot duplicate a write. A TLS verdict is terminal and
# never causes a port switch -- all the listeners carry the same certificate, so a mismatch means
# something else is answering, not that the next port would be better.
CONNECTION_LEVEL_CODES = frozenset({"network", "timeout"})


def _context():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # The collector's certificate is self-signed and untrusted by the OS store, so chain and
    # hostname validation are off. Trust is re-established by _verify_pin on every new connection;
    # without that check CERT_NONE would accept any machine on the path, so it is not optional and
    # there is no request path that skips it.
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


class Response:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):
        return json.loads(self.body.decode("utf8"))


class Transport:
    """One keep-alive HTTPS connection per collector listener, pinned by certificate fingerprint.

    Identity is the SHA-256 of the DER, not a hostname, so a collector addressed by LAN IP with no
    DNS entry works, and SNI is left off the handshake for the same reason.

    `ports` (or a single `port`) is the collector's listener set. Every listener on the collector
    presents the same certificate and serves the same router, so the list is availability, not
    identity: the pin check is unchanged whichever port a request lands on."""

    def __init__(self, host, port=None, pin=None, timeout_ms=15000, ports=None):
        if not PIN_RE.match(str(pin or "")):
            raise ClientError(0, "pin_missing", "a 64-hex-char certificate fingerprint is required")
        self.host = host
        self._ports = _port_list(ports if ports is not None else [port])
        if not self._ports:
            raise ClientError(0, "port_missing", "no usable collector port supplied")
        # Ports are tried in the configured order starting from the one that last worked, which is
        # what keeps a device that failed over once from re-probing the dead listener every request.
        self._cursor = 0
        # The port a request lands on is the list entry at `self._cursor`; this is the single-port
        # view callers that do not care about failover still read.
        self.port = self._ports[self._cursor]
        self.expected_pin = bytes.fromhex(str(pin).lower())
        self.timeout = timeout_ms / 1000
        self._context = _context()
        self._conn = None
        self._conn_port = None
        # Set only after a certificate has actually been compared against the pin, so a caller can
        # never report a verified pin for a connection that never got that far.
        self.verified = False

    def ports(self):
        """The configured listener set, in the order it is tried."""
        return list(self._ports)

    def active_port(self):
        """The port that last served a request. Later requests start from it."""
        return self._ports[self._cursor]

    def pin_verified(self):
        return self.verified

    def close(self):
        conn = self._conn
        self._conn = None
        self._conn_port = None
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass

    def _connect(self, port):
        # The cached connection belongs to one listener. After a failover it must not be reused for
        # a different port: the request would keep going to the port that already answered, and the
        # reported active port would be a lie.
        if self._conn is not None and self._conn_port != port:
            self.close()
        if self._conn is not None:
            return self._conn
        try:
            tcp = socket.create_connection((self.host, port), self.timeout)
        except ConnectionRefusedError as err:
            raise ClientError(0, "network", "collector unreachable") from err
        except OSError as err:
            raise ClientError(0, "network", str(err)) from err
        try:
            tls = self._context.wrap_socket(tcp, server_hostname=None)
        except (OSError, ssl.SSLError) as err:
            tcp.close()
            raise ClientError(0, "network", f"tls handshake failed: {err}") from err
        # The pin verdict is raised out of here, not wrapped: a mismatch is terminal and must never
        # look like a connection-level failure that the next port could fix.
        self._verify_pin(tls)
        conn = http.client.HTTPConnection(self.host, port, timeout=self.timeout)
        conn.sock = tls
        self._conn = conn
        self._conn_port = port
        return conn

    def _verify_pin(self, tls):
        der = tls.getpeercert(binary_form=True)
        if not der:
            tls.close()
            raise ClientError(0, "tls_no_certificate", "peer presented no certificate")
        got = hashlib.sha256(der).digest()
        if not hmac.compare_digest(got, self.expected_pin):
            tls.close()
            raise ClientError(
                0, "tls_pin_mismatch",
                f"cert {got.hex()} does not match the pin. Refusing to send. This means the "
                "collector was reinstalled, or something else is answering on that port.")
        self.verified = True

    def _request(self, method, path, headers, body, expect, stream_file=None):
        last_error = None
        for step in range(len(self._ports)):
            index = (self._cursor + step) % len(self._ports)
            try:
                response = self._request_on(self._ports[index], method, path, headers, body,
                                            expect, stream_file)
            except ClientError as err:
                if not _is_connection_level(err):
                    raise
                last_error = err
                continue
            self._cursor = index
            self.port = self._ports[index]
            return response
        raise last_error if last_error is not None else ClientError(
            0, "network", "collector unreachable on every configured port")

    def _request_on(self, port, method, path, headers, body, expect, stream_file=None):
        reconnected = False
        while True:
            try:
                conn = self._connect(port)
                conn.putrequest(method, path, skip_accept_encoding=True)
                for name, value in headers.items():
                    conn.putheader(name, str(value))
                conn.endheaders()
                if stream_file is not None:
                    with open(stream_file, "rb") as fh:
                        while True:
                            chunk = fh.read(_READ_CHUNK)
                            if not chunk:
                                break
                            conn.send(chunk)
                elif body is not None:
                    conn.send(body)
                response = conn.getresponse()
                data = _read_body(response)
                headers_out = {k.lower(): v for k, v in response.getheaders()}
                status = response.status
                # Close even when the body is empty: http.client holds the connection in
                # "response pending" until close(), so the next request on that socket raises
                # ResponseNotReady *after* its body is already on the wire, and the retry below
                # then delivers every batch twice.
                response.close()
                if headers_out.get("connection", "").lower() == "close":
                    self.close()
                if status not in expect:
                    raise _status_error(status, data)
                return Response(status, headers_out, data)
            except ClientError:
                raise
            except (http.client.HTTPException, OSError) as err:
                self.close()
                if reconnected:
                    raise ClientError(0, "network", str(err) or err.__class__.__name__) from err
                reconnected = True

    def get(self, path, headers=None, expect=(200, 304)):
        return self._request("GET", path, dict(headers or {}), None, expect)

    def post_json(self, path, obj, headers=None, expect=(200, 201, 202, 204)):
        payload = json.dumps(obj).encode("utf8")
        merged = {"content-type": "application/json", "content-length": len(payload),
                  **dict(headers or {})}
        return self._request("POST", path, merged, payload, expect)

    def post_gzip_ndjson(self, path, events, headers=None):
        payload = ("\n".join(json.dumps(e) for e in events) + "\n").encode("utf8")
        compressed = gzip.compress(payload, compresslevel=6, mtime=0)
        merged = {"content-type": "application/x-ndjson", "content-encoding": "gzip",
                  "content-length": len(compressed), **dict(headers or {})}
        return self._request("POST", path, merged, compressed, (200,))

    def post_png(self, path, file, headers=None, sha256=None, phash=None):
        merged = {"content-type": "application/png", "content-length": os.path.getsize(file),
                  **dict(headers or {})}
        if sha256:
            merged["x-sha256"] = sha256
        if phash:
            merged["x-phash"] = phash
        return self._request("POST", path, merged, None, (200, 201), stream_file=file)


def _port_list(values):
    """Normalise the configured listeners: integers in 1..65535, de-duplicated, order preserved."""
    out = []
    for value in values or []:
        port = _to_port(value)
        if port is None or not 1 <= port <= 65535 or port in out:
            continue
        out.append(port)
    return out


def _to_port(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    # Mirrors the Node client's Number.isInteger filter: "8443.5" and "anything" are not ports, and
    # an unusable entry is dropped rather than guessed at.
    if not number.is_integer():
        return None
    return int(number)


def _is_connection_level(err):
    return isinstance(err, ClientError) and err.code in CONNECTION_LEVEL_CODES


def _read_body(response):
    # A 204/304 carries no body, and reading one from a keep-alive connection would block.
    length = response.headers.get("content-length")
    if response.status in (204, 304) or length == "0":
        return b""
    chunks = []
    size = 0
    while True:
        chunk = response.read(_READ_CHUNK)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise ClientError(response.status, "response_too_large", "response exceeded bounds")
        chunks.append(chunk)
    return b"".join(chunks)


def _status_error(status, body):
    try:
        parsed = json.loads((body.decode("utf8") or "{}"))
    except ValueError:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    return ClientError(status, parsed.get("error") or "unexpected_status",
                       parsed.get("detail") or f"HTTP {status}", parsed.get("retry_after"))
