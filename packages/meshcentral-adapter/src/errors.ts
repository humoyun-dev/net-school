export type AdapterErrorCode =
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'upstream_rejected'
  | 'upstream_auth_failed'
  | 'upstream_tls_failed'
  | 'invalid_upstream_message'
  | 'scope_denied';

// Adapter tashqarisiga faqat shu barqaror kodlar chiqadi; upstream xato matni detail'da.
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly detail: unknown;

  constructor(code: AdapterErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.detail = detail;
  }
}
