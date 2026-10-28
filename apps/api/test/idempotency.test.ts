import { Body, Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ApiError } from '../src/common/errors.ts';
import { Idempotency, idempotencyKeyOf } from '../src/common/idempotency.ts';
import { requestContext } from '../src/common/request-context.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedUser } from './support/seed.ts';

let runs = 0;
let failNext = false;

@Controller('api/v1/test-idem')
class IdemController {
  constructor(@Inject(Idempotency) private readonly idem: Idempotency) {}

  @Post(':scope')
  async go(
    @Param('scope') scope: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.idem.run(
      requestContext(req),
      `test:${scope}`,
      idempotencyKeyOf(req),
      body,
      201,
      async () => {
        runs += 1;
        if (failNext) {
          failNext = false;
          throw new ApiError('conflict', 'work failed');
        }
        return { run: runs, echo: body };
      },
    );
    res.status(result.status);
    return result.body;
  }
}

let now = 1_800_000_000_000;
let app: TestApp;
let alice: string;
let bob: string;

beforeAll(async () => {
  app = await startTestApp({ controllers: [IdemController], now: () => now });
});
beforeEach(async () => {
  runs = 0;
  failNext = false;
  await app.db.reset();
  const { orgId } = await seedOrg(app.db.db);
  await seedUser(app.db.db, orgId, 'alice', [{ role: 'school_admin', siteId: null }]);
  await seedUser(app.db.db, orgId, 'bob', [{ role: 'school_admin', siteId: null }]);
  alice = await loginAs(app, 'alice');
  bob = await loginAs(app, 'bob');
});
afterAll(async () => {
  await app?.close();
});

const post = (cookie: string, key: string | null, body: unknown = { a: 1 }, scope = 'one') =>
  app.request('POST', `/api/v1/test-idem/${scope}`, {
    body,
    cookie,
    headers: key === null ? {} : { 'idempotency-key': key },
  });

describe('Idempotency-Key', () => {
  test('missing or malformed key is rejected', async () => {
    for (const key of [null, 'short', 'has spaces in it', 'x'.repeat(129)]) {
      const res = await post(alice, key);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('validation_failed');
    }
    expect(runs).toBe(0);
  });

  test('same key replays the stored response', async () => {
    const first = await post(alice, 'key-0001');
    const second = await post(alice, 'key-0001');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json).toEqual(first.json);
    expect(runs).toBe(1);
  });

  test('same key with a different body conflicts', async () => {
    await post(alice, 'key-0002', { a: 1 });
    const res = await post(alice, 'key-0002', { a: 2 });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    // Kalit tartibi farq qilmaydi.
    expect((await post(alice, 'key-0003', { a: 1, b: 2 })).status).toBe(201);
    expect((await post(alice, 'key-0003', { b: 2, a: 1 })).status).toBe(201);
    expect(runs).toBe(2);
  });

  test('failed work is not stored and can be retried', async () => {
    failNext = true;
    expect((await post(alice, 'key-0004')).status).toBe(409);
    const retry = await post(alice, 'key-0004');
    expect(retry.status).toBe(201);
    expect(retry.json.run).toBe(2);
  });

  test('concurrent requests with one key run once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => post(alice, 'key-0005')));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => JSON.stringify(r.json))).size).toBe(1);
    expect(runs).toBe(1);
  });

  test('keys are scoped per actor and route', async () => {
    await post(alice, 'key-0006');
    await post(bob, 'key-0006');
    await post(alice, 'key-0006', { a: 1 }, 'two');
    expect(runs).toBe(3);
  });

  test('keys expire after 24 hours', async () => {
    await post(alice, 'key-0007');
    now += 24 * 3_600_000 + 1;
    alice = await loginAs(app, 'alice');
    const again = await post(alice, 'key-0007');
    expect(again.status).toBe(201);
    expect(runs).toBe(2);
  });
});
