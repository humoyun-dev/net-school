import { Controller, Get } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, users } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { createTestDb, type TestDb } from './support/db.ts';
import { cookieFrom, PASSWORD, seedOrg, seedUser } from './support/seed.ts';

@Controller('api/v1/test')
class ProtectedController {
  @Get('protected')
  get() {
    return { ok: true };
  }
}

const START = Date.parse('2026-10-28T08:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
let now = START;
let t: TestDb;
let app: TestApp;
let orgId: string;
let siteId: string;

beforeAll(async () => {
  t = await createTestDb();
  app = await startTestApp({ db: t, now: () => now, controllers: [ProtectedController] });
});
beforeEach(async () => {
  now += 10 * MIN; // IP oynasi har testda yangilanadi
  await t.reset();
  ({ orgId, siteId } = await seedOrg(t.db));
  await seedUser(t.db, orgId, 'teacher1', [{ role: 'teacher', siteId }]);
});
afterAll(async () => {
  await app?.close();
  await t?.close();
});

const login = (username: string, password: string) =>
  app.request('POST', '/api/v1/auth/login', { body: { username, password } });

async function session(username = 'teacher1') {
  const res = await login(username, PASSWORD);
  expect(res.status).toBe(200);
  return cookieFrom(res.headers.get('set-cookie'));
}

describe('login', () => {
  test('login sets a host-only HttpOnly Secure SameSite=Strict session cookie', async () => {
    const res = await login('TEACHER1', PASSWORD);
    expect(res.status).toBe(200);
    expect(res.json.user).toMatchObject({ username: 'teacher1', mustChangePassword: false });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^__Host-ns_sid=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/Max-Age|Expires|Domain/i);
  });

  test('wrong password and unknown user get the same 401', async () => {
    const wrong = await login('teacher1', 'wrong-password-123');
    const unknown = await login('ghost', 'wrong-password-123');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect({ ...wrong.json.error, correlationId: '' }).toEqual({ ...unknown.json.error, correlationId: '' });
  });

  test('account locks after 10 failures for 15 minutes', async () => {
    for (let i = 0; i < 10; i++) expect((await login('teacher1', 'nope-nope-nope')).status).toBe(401);
    expect((await login('teacher1', PASSWORD)).status).toBe(401);
    now += 15 * MIN - 1;
    expect((await login('teacher1', PASSWORD)).status).toBe(401);
    now += 1;
    expect((await login('teacher1', PASSWORD)).status).toBe(200);
    const [row] = await t.db.select().from(users).where(eq(users.username, 'teacher1'));
    expect(row).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  test('concurrent failed logins lock the account exactly once', async () => {
    const attempts = Array.from({ length: 20 }, () => login('teacher1', 'nope-nope-nope'));
    expect((await Promise.all(attempts)).map((r) => r.status)).toEqual(Array(20).fill(401));
    const [row] = await t.db.select().from(users).where(eq(users.username, 'teacher1'));
    expect(row?.lockedUntil?.getTime()).toBe(now + 15 * MIN);
    const lockouts = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.lockout'));
    expect(lockouts).toHaveLength(1);
    expect((await login('teacher1', PASSWORD)).status).toBe(401);
  });

  test('a correct password whose check overlaps a lockout does not clear the lock', async () => {
    const pending = login('teacher1', PASSWORD); // SELECT qulfsiz holatni ko'radi, keyin scrypt ishlaydi
    await new Promise((r) => setTimeout(r, 5));
    await t.db
      .update(users)
      .set({ failedLoginCount: 10, lockedUntil: new Date(now + 15 * MIN) })
      .where(eq(users.username, 'teacher1'));
    expect((await pending).status).toBe(401);
    const [row] = await t.db.select().from(users).where(eq(users.username, 'teacher1'));
    expect(row?.lockedUntil?.getTime()).toBe(now + 15 * MIN);
  });

  test('ip limit returns 429 after 30 attempts per minute', async () => {
    for (let i = 0; i < 30; i++) expect((await login('ghost', 'x-x-x-x-x-x')).status).toBe(401);
    const limited = await login('teacher1', PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('rate_limited');
    now += MIN;
    expect((await login('teacher1', PASSWORD)).status).toBe(200);
  });

  test('invalid login body is a validation error', async () => {
    const res = await app.request('POST', '/api/v1/auth/login', { body: { username: 'teacher1' } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation_failed');
  });
});

describe('sessions', () => {
  test('requests without a session get 401 unauthenticated', async () => {
    const res = await app.request('GET', '/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('unauthenticated');
    expect((await app.request('GET', '/api/v1/me', { cookie: '__Host-ns_sid=forged' })).status).toBe(401);
  });

  test('me returns the actor with assignments', async () => {
    const cookie = await session();
    const res = await app.request('GET', '/api/v1/me', { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      user: { username: 'teacher1' },
      organizationId: orgId,
      assignments: [{ role: 'teacher', siteId }],
      roomIds: [],
    });
  });

  test('session expires at idle and absolute limits', async () => {
    const idle = await session();
    now += 2 * HOUR - 1;
    expect((await app.request('GET', '/api/v1/me', { cookie: idle })).status).toBe(200);
    now += 2 * HOUR; // oxirgi faollikdan aniq 2 soat
    expect((await app.request('GET', '/api/v1/me', { cookie: idle })).status).toBe(401);

    const active = await session();
    const started = now;
    while (now < started + 12 * HOUR - HOUR) {
      now += HOUR;
      expect((await app.request('GET', '/api/v1/me', { cookie: active })).status).toBe(200);
    }
    now = started + 12 * HOUR; // faol bo'lsa ham absolyut chegara
    expect((await app.request('GET', '/api/v1/me', { cookie: active })).status).toBe(401);
  });

  test('logout invalidates the session', async () => {
    const cookie = await session();
    const res = await app.request('POST', '/api/v1/auth/logout', { cookie });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/__Host-ns_sid=;.*Max-Age=0/);
    expect((await app.request('GET', '/api/v1/me', { cookie })).status).toBe(401);
  });
});

describe('password', () => {
  test('wrong current passwords count toward the lockout and are audited', async () => {
    const cookie = await session();
    for (let i = 0; i < 10; i++) {
      const res = await app.request('POST', '/api/v1/auth/password', {
        cookie,
        body: { currentPassword: `guess-${i}-xxxxxx`, newPassword: 'Yangi-uzun-parol-1' },
      });
      expect(res.status).toBe(401);
    }
    const right = await app.request('POST', '/api/v1/auth/password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: 'Yangi-uzun-parol-1' },
    });
    expect(right.status).toBe(401); // hisob qulflangan
    expect((await login('teacher1', PASSWORD)).status).toBe(401);
    const failed = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.password_changed'));
    expect(failed.filter((r) => r.result === 'failed')).toHaveLength(11);
  });

  test('must-change-password restricts routes until the password is changed', async () => {
    await seedUser(t.db, orgId, 'newadmin', [{ role: 'school_admin', siteId: null }], { mustChangePassword: true });
    const res = await login('newadmin', PASSWORD);
    expect(res.json.user.mustChangePassword).toBe(true);
    const cookie = cookieFrom(res.headers.get('set-cookie'));
    expect((await app.request('GET', '/api/v1/me', { cookie })).status).toBe(200);
    const blocked = await app.request('GET', '/api/v1/test/protected', { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('password_change_required');

    const change = await app.request('POST', '/api/v1/auth/password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: 'Yangi-uzun-parol-1' },
    });
    expect(change.status).toBe(204);
    expect((await app.request('GET', '/api/v1/me', { cookie })).json.user.mustChangePassword).toBe(false);
    expect((await app.request('GET', '/api/v1/test/protected', { cookie })).status).toBe(200);
  });

  test('password change revokes other sessions', async () => {
    const a = await session();
    const b = await session();
    const tooShort = await app.request('POST', '/api/v1/auth/password', {
      cookie: a,
      body: { currentPassword: PASSWORD, newPassword: 'short' },
    });
    expect(tooShort.status).toBe(400);
    const wrong = await app.request('POST', '/api/v1/auth/password', {
      cookie: a,
      body: { currentPassword: 'not-the-password', newPassword: 'Yangi-uzun-parol-1' },
    });
    expect(wrong.status).toBe(401);
    const ok = await app.request('POST', '/api/v1/auth/password', {
      cookie: a,
      body: { currentPassword: PASSWORD, newPassword: 'Yangi-uzun-parol-1' },
    });
    expect(ok.status).toBe(204);
    expect((await app.request('GET', '/api/v1/me', { cookie: a })).status).toBe(200);
    expect((await app.request('GET', '/api/v1/me', { cookie: b })).status).toBe(401);
    expect((await login('teacher1', 'Yangi-uzun-parol-1')).status).toBe(200);
  });

  test('login failures and successes are audited without the password', async () => {
    await login('teacher1', 'wrong-password-123');
    await login('ghost', 'wrong-password-123');
    await session();
    const rows = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.login'));
    expect(rows.map((r) => r.result).sort()).toEqual(['failed', 'failed', 'succeeded']);
    const ghost = rows.find((r) => r.organizationId === null);
    expect(ghost?.targetId).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('wrong-password-123');
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });
});
