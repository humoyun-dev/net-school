import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ApiFailure, createApi } from '../src/api/client.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function setup(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply(String(url), init ?? {});
  }) as unknown as typeof fetch;
  const onUnauthenticated = vi.fn();
  const onPasswordChange = vi.fn();
  return { api: createApi(fetchImpl, onUnauthenticated, onPasswordChange), calls, onUnauthenticated, onPasswordChange };
}

describe('api client', () => {
  test('error envelope becomes ApiFailure with code and correlationId', async () => {
    const { api } = setup(() =>
      json(409, { error: { code: 'control_busy', message: 'busy', correlationId: 'corr-12345678' } }),
    );
    const err = await api.send('POST', '/api/v1/x', {}, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err).toMatchObject({ status: 409, code: 'control_busy', correlationId: 'corr-12345678' });
  });

  test('a non-JSON failure still becomes an ApiFailure', async () => {
    const { api } = setup(() => new Response('bad gateway', { status: 502 }));
    const err = await api.get('/api/v1/x', z.object({})).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'internal', correlationId: null });
  });

  test('a 401 anywhere returns to login', async () => {
    const { api, onUnauthenticated } = setup(() =>
      json(401, { error: { code: 'unauthenticated', message: 'no', correlationId: null } }),
    );
    await api.get('/api/v1/me', z.object({})).catch(() => {});
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  test('password_change_required routes to the password page', async () => {
    const { api, onPasswordChange, onUnauthenticated } = setup(() =>
      json(403, { error: { code: 'password_change_required', message: 'x', correlationId: null } }),
    );
    await api.get('/api/v1/sites', z.object({})).catch(() => {});
    expect(onPasswordChange).toHaveBeenCalledTimes(1);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  test('requests are same-origin JSON with the idempotency key and responses are validated', async () => {
    const { api, calls } = setup(() => json(202, { id: 'a' }));
    const out = await api.send('POST', '/api/v1/lessons', { title: 'x' }, z.object({ id: z.string() }), {
      idempotencyKey: 'key-12345678',
    });
    expect(out).toEqual({ id: 'a' });
    const [call] = calls;
    expect(call?.init.credentials).toBe('same-origin');
    expect(call?.init.body).toBe(JSON.stringify({ title: 'x' }));
    expect(new Headers(call?.init.headers).get('idempotency-key')).toBe('key-12345678');
    expect(new Headers(call?.init.headers).get('content-type')).toBe('application/json');
    const { api: bad } = setup(() => json(200, { id: 5 }));
    await expect(bad.get('/api/v1/x', z.object({ id: z.string() }))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  test('204 returns null when no schema is given', async () => {
    const { api } = setup(() => new Response(null, { status: 204 }));
    expect(await api.send('DELETE', '/api/v1/x', undefined, null)).toBeNull();
  });
});
