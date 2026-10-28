export type ApiErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'scope_denied'
  | 'password_change_required'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  scope_denied: 403,
  password_change_required: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

const DEFAULT_MESSAGE: Record<ApiErrorCode, string> = {
  validation_failed: 'Request is invalid',
  unauthenticated: 'Authentication required',
  scope_denied: 'Not allowed',
  password_change_required: 'Password change required',
  not_found: 'Not found',
  conflict: 'Conflict',
  rate_limited: 'Too many requests',
  internal: 'Internal error',
};

// Barqaror kod + mijozga ko'rinadigan xabar; ichki tafsilot hech qachon xabarga qo'yilmaydi.
export class ApiError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.code = code;
  }
}

export function defaultMessage(code: ApiErrorCode): string {
  return DEFAULT_MESSAGE[code];
}
