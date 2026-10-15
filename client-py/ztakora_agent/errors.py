TERMINAL_CODES = frozenset({
    "bad_request", "unsupported_media", "content_field_forbidden", "token_invalid",
    "token_mismatch", "tls_pin_mismatch", "tls_no_certificate", "response_too_large",
    "body_too_large", "unknown_route",
})


class ClientError(Exception):
    def __init__(self, status, code, detail=None, retry_after=None):
        super().__init__(detail or code)
        self.status = status
        self.code = code
        self.detail = detail
        self.retry_after = retry_after


def is_retryable(err):
    """A wrong request must not be re-sent. Retrying a 422 content rejection would mean offering
    clipboard text again on every attempt."""
    if not isinstance(err, ClientError):
        return True
    if err.code in TERMINAL_CODES:
        return False
    if err.code in ("state_not_approved", "notice_outdated"):
        return False
    return True
