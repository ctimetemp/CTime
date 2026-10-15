import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// A self-signed X.509v3 certificate built by hand, so that installing the collector requires
// Node and nothing else. openssl is present on this dev box but cannot be assumed on a locked
//-down LAN endpoint with no internet, and npm is off the table by the stack rules.
//
// Only what a TLS server actually needs is emitted: CA=false, digitalSignature+keyEncipherment,
// serverAuth EKU, and SAN entries for the LAN addresses. `server` is also put in the subject CN
// because Node's pinning path reads the raw DER and never matches names anyway.

const ASN = {
  BOOLEAN: 0x01, INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05,
  OID: 0x06, UTF8: 0x0c, Printable: 0x13, IA5: 0x16, UTC: 0x17, Gen: 0x18,
  SEQUENCE: 0x30, SET: 0x31,
};

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

function seq(...parts) { return tlv(ASN.SEQUENCE, Buffer.concat(parts)); }
function set(...parts) { return tlv(ASN.SET, Buffer.concat(parts)); }

function derInt(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0x00) b = b.subarray(1);
  // A leading byte >= 0x80 would read as a negative number; DER prepends a zero octet.
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(ASN.INTEGER, b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >>> 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(...stack);
  }
  return tlv(ASN.OID, Buffer.from(out));
}

// DER booleans are tag 0x01 with a payload of exactly one octet, FF for true and 00 for false.
function derBool(v) { return tlv(ASN.BOOLEAN, Buffer.from([v ? 0xff : 0x00])); }
function derNull() { return tlv(ASN.NULL, Buffer.alloc(0)); }
function bitString(buf, unusedBits = 0) {
  return tlv(ASN.BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), buf]));
}

// Time is UTCTime (YYMMDDHHMMSSZ) for 1950-2049 and GeneralizedTime otherwise.
function derTime(date) {
  const yy = date.getUTCFullYear();
  const stamp = [
    String(yy).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  if (yy >= 1950 && yy <= 2049) {
    return tlv(ASN.UTC, Buffer.from(`${stamp.slice(2)}Z`, 'ascii'));
  }
  return tlv(ASN.Gen, Buffer.from(`${stamp}Z`, 'ascii'));
}

const CN_OID = '2.5.4.3';
const O_OID = '2.5.4.10';

function name(attrs) {
  return tlv(ASN.SEQUENCE, Buffer.concat(
    attrs.map(([key, value]) => set(seq(oid(key), tlv(ASN.UTF8, Buffer.from(value, 'utf8'))))),
  ));
}

function extension(oidDotted, critical, valueBuffer) {
  return seq(oid(oidDotted), ...(critical ? [derBool(true)] : []), tlv(ASN.OCTET_STRING, valueBuffer));
}

// 7-bit packed IPv4 for iPAddress SAN. Note the extension value is the raw address, not a
// DER string -- a common place hand-rolled builders go wrong.
function ipBytes(dotted) {
  const parts = dotted.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return Buffer.from(parts);
}

function subjectAltName(hosts, ips) {
  const entries = [];
  for (const h of hosts) {
    const ascii = Buffer.from(h, 'ascii');
    entries.push(Buffer.concat([Buffer.from([0x82]), len(ascii.length), ascii])); // [2] dNSName
  }
  for (const ip of ips) {
    const b = ipBytes(ip);
    if (b) entries.push(Buffer.concat([Buffer.from([0x87]), len(b.length), b])); // [7] iPAddress
  }
  return tlv(0x30, Buffer.concat(entries));
}

const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SAN = '2.5.29.17';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_KEY_ID = '2.5.29.14';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';

// keyUsage bits are numbered from the MSB of the first octet: bit 0 digitalSignature (0x80),
// bit 2 keyEncipherment (0x20). Together that is 0xA0 with 5 trailing unused bits --
// 0x04/0x80 would have meant keyAgreement, which is not what a TLS server needs.
const KEY_USAGE_SIG_ENC = Buffer.from([0xa0]);
const UNUSED_BITS_SIG_ENC = 5;

export function createSelfSigned({ hosts = [], ips = [], days = 3650, organization = 'CTTIme' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const spki = publicKey; // already SubjectPublicKeyInfo DER
  const privatePem = privateKey;

  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.now() + days * 86400000);
  const serial = derInt(Buffer.from([(randomBytes(1)[0] & 0x7f), ...randomBytes(15)]));

  const keyId = createHash('sha1').update(spki).digest();
  const sigAlgId = seq(oid(OID_SHA256_RSA), derNull());
  const subject = name([[CN_OID, 'CTTIme-collector'], [O_OID, organization]]);

  const allHosts = [...new Set(['localhost', 'CTTIme.local', ...hosts])];
  const allIps = [...new Set(['127.0.0.1', ...ips])];

  const extensions = tlv(0xa3, seq( // [3] EXPLICIT Extensions
    extension(OID_SUBJECT_KEY_ID, false, tlv(ASN.OCTET_STRING, keyId)),
    extension(OID_BASIC_CONSTRAINTS, true, seq(derBool(false))),
    extension(OID_KEY_USAGE, true, tlv(ASN.BIT_STRING,
      Buffer.concat([Buffer.from([UNUSED_BITS_SIG_ENC]), KEY_USAGE_SIG_ENC]))),
    extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
    extension(OID_SAN, false, subjectAltName(allHosts, allIps)),
  ));

  const tbs = tlv(ASN.SEQUENCE,
    // [0] EXPLICIT version: 2 == v3
    Buffer.concat([
      tlv(0xa0, derInt(Buffer.from([2]))),
      serial,
      sigAlgId,
      subject, // self-signed: issuer == subject
      seq(derTime(notBefore), derTime(notAfter)),
      subject,
      // spki is already a complete SubjectPublicKeyInfo (OID + BIT STRING of the key), so it is
      // embedded as-is. Re-wrapping it in seq(sigAlgId, bitString(spki)) double-encodes the key
      // and produces a certificate no parser will read.
      spki,
      extensions,
    ]),
  );

  const signature = sign('sha256', tbs, privatePem);
  const cert = tlv(ASN.SEQUENCE, Buffer.concat([tbs, sigAlgId, bitString(signature)]));

  return {
    certPem: toPem('CERTIFICATE', cert),
    keyPem: privatePem,
    der: cert,
    fingerprint: createHash('sha256').update(cert).digest('hex'),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    hosts: allHosts,
    ips: allIps,
  };
}

function toPem(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export function fingerprintOfPem(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex');
}
