import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestApp, type TestApp } from './support/app.ts';

let dir: string;
let app: TestApp;
let bare: TestApp;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'web-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>NetSchool</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(tmpdir(), 'outside-secret.txt'), 'secret');
  app = await startTestApp({ webDistDir: dir });
  bare = await startTestApp({ db: app.db });
});
afterAll(async () => {
  await bare?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

describe('static web panel', () => {
  test('serves index.html for app routes with no-store and the CSP', async () => {
    for (const path of ['/', '/rooms/123', '/power']) {
      const res = await app.request('GET', path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.bytes.toString()).toContain('<title>NetSchool</title>');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toBe(CSP);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  test('serves hashed assets as immutable', async () => {
    const res = await app.request('GET', '/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.bytes.toString()).toBe('console.log(1)');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    const missing = await app.request('GET', '/assets/nope.js');
    expect(missing.status).toBe(404);
  });

  test('api paths stay JSON 404 and are not swallowed by the SPA', async () => {
    const res = await app.request('GET', '/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
    expect((await app.request('GET', '/api/v1/healthz')).json.status).toBeDefined();
  });

  test('without WEB_DIST_DIR no static files are served', async () => {
    const res = await bare.request('GET', '/rooms/123');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });

  test('frame-src names the gateway origin when configured', async () => {
    const withGateway = await startTestApp({ db: app.db, webDistDir: dir, gatewayOrigin: 'https://localhost:8444' });
    try {
      const res = await withGateway.request('GET', '/');
      expect(res.headers.get('content-security-policy')).toContain('frame-src https://localhost:8444;');
    } finally {
      await withGateway.close();
    }
  });

  test('path traversal outside the dist directory is refused', async () => {
    for (const path of ['/..%2f..%2foutside-secret.txt', '/assets/..%2f..%2f..%2foutside-secret.txt']) {
      const res = await app.request('GET', path);
      expect(res.bytes.toString(), path).not.toContain('secret');
    }
  });
});
