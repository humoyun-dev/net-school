import { expect } from 'vitest';
import type { TestApp } from './app.ts';
import { cookieFrom, PASSWORD } from './seed.ts';

export async function loginAs(app: TestApp, username: string): Promise<string> {
  const res = await app.request('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } });
  expect(res.status, `login ${username}`).toBe(200);
  return cookieFrom(res.headers.get('set-cookie'));
}
