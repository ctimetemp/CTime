export class HttpError extends Error {
  constructor(status, code, detail, retryAfter) {
    super(detail || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

// Codes that must not be retried: the request is wrong, not the connection. Retrying a 422
// content rejection would mean re-sending clipboard text over and over.
export const TERMINAL_CODES = new Set([
  'bad_request', 'unsupported_media', 'content_field_forbidden', 'token_invalid',
  'token_mismatch', 'tls_pin_mismatch', 'tls_no_certificate', 'response_too_large',
  'body_too_large', 'unknown_route',
]);

export function isRetryable(err) {
  if (!(err instanceof HttpError)) return true;
  if (TERMINAL_CODES.has(err.code)) return false;
  if (err.code === 'state_not_approved' || err.code === 'notice_outdated') return false;
  return true;
}
