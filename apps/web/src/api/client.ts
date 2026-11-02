import type { ZodType } from 'zod';

// API xatosi: kod bo'yicha tarjima qilinadi, correlationId foydalanuvchiga ko'rsatiladi (qo'llab-quvvatlash uchun).
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;

  constructor(status: number, code: string, message: string, correlationId: string | null) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

export interface Api {
  get<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T>;
  send<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    schema: ZodType<T> | null,
    opts?: { idempotencyKey?: string; signal?: AbortSignal; keepalive?: boolean },
  ): Promise<T>;
}

// Panel API bilan bir origin'da: cookie avtomatik (same-origin), CORS yo'q. 401 → login, parol almashtirish → o'sha sahifa.
export function createApi(fetchImpl: typeof fetch, onUnauthenticated: () => void, onPasswordChange: () => void): Api {
  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    schema: ZodType<T> | null,
    opts: { idempotencyKey?: string; signal?: AbortSignal; keepalive?: boolean } = {},
  ): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (opts.idempotencyKey) headers.set('idempotency-key', opts.idempotencyKey);
    const res = await fetchImpl(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: opts.signal,
      keepalive: opts.keepalive,
    });
    if (!res.ok) {
      let code = 'internal';
      let message = res.statusText;
      let correlationId: string | null = res.headers.get('x-correlation-id');
      try {
        const env = (await res.json()) as { error?: { code?: unknown; message?: unknown; correlationId?: unknown } };
        if (typeof env.error?.code === 'string') code = env.error.code;
        if (typeof env.error?.message === 'string') message = env.error.message;
        if (typeof env.error?.correlationId === 'string') correlationId = env.error.correlationId;
      } catch {
        // JSON bo'lmagan xato (proksi, 502) — kod internal qoladi.
      }
      if (res.status === 401) onUnauthenticated();
      if (code === 'password_change_required') onPasswordChange();
      throw new ApiFailure(res.status, code, message, correlationId);
    }
    if (res.status === 204 || schema === null) return null as T;
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) throw new ApiFailure(res.status, 'invalid_response', 'Unexpected response', null);
    return parsed.data;
  }
  return {
    get: (path, schema, signal) => call('GET', path, undefined, schema, { signal }),
    send: (method, path, body, schema, opts) => call(method, path, body, schema, opts),
  };
}
