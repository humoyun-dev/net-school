import { afterAll, beforeAll, expect, test } from 'vitest';
import { startTestApp, type TestApp } from './support/app.ts';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});

afterAll(async () => {
  await app?.close();
});

test('healthz responds over HTTPS with ok', async () => {
  const res = await app.request('GET', '/api/v1/healthz');
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ status: 'ok' });
});

test('response echoes a valid correlation id and replaces an invalid one', async () => {
  const valid = await app.request('GET', '/api/v1/healthz', { headers: { 'x-correlation-id': 'abc-12345' } });
  expect(valid.headers.get('x-correlation-id')).toBe('abc-12345');

  const invalid = await app.request('GET', '/api/v1/healthz', { headers: { 'x-correlation-id': 'bad id!' } });
  const replaced = invalid.headers.get('x-correlation-id');
  expect(replaced).not.toBe('bad id!');
  expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
});

test('healthz reports the database state', async () => {
  const res = await app.request('GET', '/api/v1/healthz');
  expect(res.json).toEqual({ status: 'ok', db: 'ok', mesh: 'disabled' });

  const broken = await startTestApp();
  await broken.db.close();
  const down = await broken.request('GET', '/api/v1/healthz');
  expect(down.status).toBe(503);
  expect(down.json).toEqual({ status: 'degraded', db: 'down', mesh: 'disabled' });
  await broken.close();
});

test('health reports mesh state', async () => {
  // MeshCentral'siz ham API ishlaydi: mesh uzilgan bo'lsa ham HTTP 200.
  const link = { connected: true };
  const meshed = await startTestApp({ mesh: link });
  try {
    const up = await meshed.request('GET', '/api/v1/healthz');
    expect(up.status).toBe(200);
    expect(up.json).toEqual({ status: 'ok', db: 'ok', mesh: 'ok' });

    link.connected = false;
    const down = await meshed.request('GET', '/api/v1/healthz');
    expect(down.status).toBe(200);
    expect(down.json).toEqual({ status: 'ok', db: 'ok', mesh: 'down' });
  } finally {
    await meshed.close();
  }
});
