import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Get, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ApiError } from '../src/common/errors.ts';
import { loadConfig } from '../src/config/config.ts';
import { startTestApp, type TestApp } from './support/app.ts';

@Controller('api/v1/test')
class ThrowingController {
  @Get('conflict')
  conflict(): never {
    throw new ApiError('conflict', 'Already exists');
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail');
  }

  @Post('echo')
  echo() {
    return { ok: true };
  }
}

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ controllers: [ThrowingController] });
});

afterAll(async () => {
  await app?.close();
});

describe('error envelope', () => {
  test('unknown route returns not_found envelope', async () => {
    const res = await app.request('GET', '/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
    expect(res.json.error.correlationId).toBe(res.headers.get('x-correlation-id'));
  });

  test('thrown ApiError maps to status and envelope', async () => {
    const res = await app.request('GET', '/api/v1/test/conflict');
    expect(res.status).toBe(409);
    expect(res.json).toEqual({
      error: { code: 'conflict', message: 'Already exists', correlationId: res.headers.get('x-correlation-id') },
    });
  });

  test('unexpected error returns internal without details', async () => {
    const res = await app.request('GET', '/api/v1/test/boom');
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe('internal');
    expect(JSON.stringify(res.json)).not.toContain('secret internal detail');
  });

  test('POST with foreign Origin is rejected with scope_denied', async () => {
    const foreign = await app.request('POST', '/api/v1/test/echo', { headers: { origin: 'https://evil.test' } });
    expect(foreign.status).toBe(403);
    expect(foreign.json.error.code).toBe('scope_denied');

    const missing = await app.request('POST', '/api/v1/test/echo', { origin: null });
    expect(missing.status).toBe(403);

    const own = await app.request('POST', '/api/v1/test/echo');
    expect(own.status).toBe(201);
    expect(own.json).toEqual({ ok: true });
  });
});

describe('loadConfig', () => {
  test('loadConfig rejects missing PUBLIC_ORIGIN and reads *_FILE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ns-cfg-'));
    await writeFile(join(dir, 'cert.pem'), 'CERT');
    await writeFile(join(dir, 'key.pem'), 'KEY');
    await writeFile(join(dir, 'db'), 'postgres://u:p@db/netschool\n');
    const base = {
      TLS_CERT_FILE: join(dir, 'cert.pem'),
      TLS_KEY_FILE: join(dir, 'key.pem'),
      DATABASE_URL_FILE: join(dir, 'db'),
    };
    expect(() => loadConfig(base)).toThrow(/PUBLIC_ORIGIN/);

    const config = loadConfig({ ...base, PUBLIC_ORIGIN: 'https://hub.school.lan' });
    expect(config).toEqual({
      port: 8443,
      host: '0.0.0.0',
      publicOrigin: 'https://hub.school.lan',
      tls: { cert: 'CERT', key: 'KEY' },
      databaseUrl: 'postgres://u:p@db/netschool',
    });
  });

  test('loadConfig error does not echo secret values', () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'not a url', DATABASE_URL: 'postgres://u:hunter2@db/x' })).toThrow();
    try {
      loadConfig({ PUBLIC_ORIGIN: 'not a url', DATABASE_URL: 'postgres://u:hunter2@db/x' });
    } catch (err) {
      expect(String(err)).not.toContain('hunter2');
    }
  });
});
