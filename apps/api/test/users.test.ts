import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Access } from '../src/common/access.ts';
import { roleAssignments, users } from '../src/db/schema.ts';
import { AuditWriter } from '../src/modules/audit/audit.writer.ts';
import { loadActor } from '../src/modules/identity/actor.loader.ts';
import { SessionService } from '../src/modules/identity/sessions.ts';
import { UsersService } from '../src/modules/identity/users.service.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { createTestDb, type TestDb } from './support/db.ts';
import { loginAs } from './support/login.ts';
import { PASSWORD, seedOrg, seedUser } from './support/seed.ts';

let t: TestDb;
let app: TestApp;
let a: { orgId: string; siteId: string; otherSiteId: string };
let adminId: string;
let teacherId: string;

beforeAll(async () => {
  t = await createTestDb();
  app = await startTestApp({ db: t });
});
afterAll(async () => {
  await app?.close();
  await t?.close();
});
beforeEach(async () => {
  await t.reset();
  a = await seedOrg(t.db, 'A');
  const b = await seedOrg(t.db, 'B');
  adminId = await seedUser(t.db, a.orgId, 'a-admin', [{ role: 'school_admin', siteId: null }]);
  await seedUser(t.db, a.orgId, 'a-site-admin', [{ role: 'school_admin', siteId: a.siteId }]);
  teacherId = await seedUser(t.db, a.orgId, 'a-teacher', [{ role: 'teacher', siteId: a.siteId }]);
  await seedUser(t.db, b.orgId, 'b-admin', [{ role: 'school_admin', siteId: null }]);
});

const newUser = (username: string, roles: { role: string; siteId: string | null }[]) => ({
  username,
  displayName: username,
  password: 'Boshlangich-parol-1',
  roles,
});

describe('users', () => {
  test('org admin creates a teacher with a site role', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const res = await app.request('POST', '/api/v1/users', {
      cookie,
      body: newUser('teacher2', [{ role: 'teacher', siteId: a.siteId }]),
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      username: 'teacher2',
      mustChangePassword: true,
      roles: [{ role: 'teacher', siteId: a.siteId }],
    });
    expect(res.json).not.toHaveProperty('passwordHash');
    const login = await app.request('POST', '/api/v1/auth/login', {
      body: { username: 'teacher2', password: 'Boshlangich-parol-1' },
    });
    expect(login.json.user.mustChangePassword).toBe(true);
  });

  test('site admin cannot escalate to organization scope or other sites', async () => {
    const cookie = await loginAs(app, 'a-site-admin');
    const attempts = [
      newUser('esc1', [{ role: 'school_admin', siteId: null }]),
      newUser('esc2', [{ role: 'school_admin', siteId: a.siteId }]),
      newUser('esc3', [{ role: 'teacher', siteId: a.otherSiteId }]),
      newUser('esc4', [
        { role: 'teacher', siteId: a.siteId },
        { role: 'it_support', siteId: a.otherSiteId },
      ]),
    ];
    for (const body of attempts) {
      const res = await app.request('POST', '/api/v1/users', { cookie, body });
      expect(res.status, body.username).toBe(403);
    }
    expect(await t.db.select().from(users).where(eq(users.username, 'esc4'))).toHaveLength(0);
    const role = await app.request('POST', `/api/v1/users/${teacherId}/roles`, {
      cookie,
      body: { role: 'school_admin', siteId: null },
    });
    expect(role.status).toBe(403);
    const ok = await app.request('POST', '/api/v1/users', {
      cookie,
      body: newUser('teacher3', [{ role: 'teacher', siteId: a.siteId }]),
    });
    expect(ok.status).toBe(201);
  });

  test('foreign site ids are denied, not server errors', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const foreign = (await seedOrg(t.db, 'C')).siteId;
    const res = await app.request('POST', '/api/v1/users', {
      cookie,
      body: newUser('teacher9', [{ role: 'teacher', siteId: foreign }]),
    });
    expect(res.status).toBe(403);
  });

  test("removing a role revokes the user's sessions", async () => {
    const teacher = await loginAs(app, 'a-teacher');
    const cookie = await loginAs(app, 'a-admin');
    const [assignment] = await t.db.select().from(roleAssignments).where(eq(roleAssignments.userId, teacherId));
    const res = await app.request('DELETE', `/api/v1/users/${teacherId}/roles/${assignment?.id}`, { cookie });
    expect(res.status).toBe(204);
    expect((await app.request('GET', '/api/v1/me', { cookie: teacher })).status).toBe(401);
  });

  test('last organization admin cannot be removed', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const [assignment] = await t.db.select().from(roleAssignments).where(eq(roleAssignments.userId, adminId));
    const res = await app.request('DELETE', `/api/v1/users/${adminId}/roles/${assignment?.id}`, { cookie });
    expect(res.status).toBe(409);
    expect(await t.db.select().from(roleAssignments).where(eq(roleAssignments.userId, adminId))).toHaveLength(1);
  });

  test('disabled user cannot log in and loses sessions', async () => {
    const teacher = await loginAs(app, 'a-teacher');
    const cookie = await loginAs(app, 'a-admin');
    expect(
      (await app.request('PATCH', `/api/v1/users/${teacherId}`, { cookie, body: { disabled: true } })).status,
    ).toBe(200);
    expect((await app.request('GET', '/api/v1/me', { cookie: teacher })).status).toBe(401);
    const login = await app.request('POST', '/api/v1/auth/login', {
      body: { username: 'a-teacher', password: PASSWORD },
    });
    expect(login.status).toBe(401);
    expect((await app.request('PATCH', `/api/v1/users/${adminId}`, { cookie, body: { disabled: true } })).status).toBe(
      409,
    );
    expect(
      (await app.request('PATCH', `/api/v1/users/${teacherId}`, { cookie, body: { disabled: false } })).status,
    ).toBe(200);
    expect(
      (await app.request('POST', '/api/v1/auth/login', { body: { username: 'a-teacher', password: PASSWORD } })).status,
    ).toBe(200);
  });

  test('site admin cannot disable an organization admin', async () => {
    const cookie = await loginAs(app, 'a-site-admin');
    expect((await app.request('PATCH', `/api/v1/users/${adminId}`, { cookie, body: { disabled: true } })).status).toBe(
      403,
    );
  });

  test('user list never includes password hashes', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const res = await app.request('GET', '/api/v1/users', { cookie });
    expect(res.status).toBe(200);
    expect(res.json.users.map((u: { username: string }) => u.username).sort()).toEqual([
      'a-admin',
      'a-site-admin',
      'a-teacher',
    ]);
    expect(JSON.stringify(res.json)).not.toContain('scrypt$');
    const site = await app.request('GET', `/api/v1/users?siteId=${a.siteId}`, {
      cookie: await loginAs(app, 'a-site-admin'),
    });
    expect(site.json.users.map((u: { username: string }) => u.username).sort()).toEqual(['a-site-admin', 'a-teacher']);
  });

  test('non-admin role without a site is a validation error, not a server error', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const create = await app.request('POST', '/api/v1/users', {
      cookie,
      body: newUser('teacher7', [{ role: 'teacher', siteId: null }]),
    });
    expect(create.status).toBe(400);
    const add = await app.request('POST', `/api/v1/users/${teacherId}/roles`, {
      cookie,
      body: { role: 'it_support', siteId: null },
    });
    expect(add.status).toBe(400);
  });

  test('removing the org admin role of a disabled admin is allowed while another admin is enabled', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const second = await seedUser(t.db, a.orgId, 'a-admin2', [{ role: 'school_admin', siteId: null }]);
    expect((await app.request('PATCH', `/api/v1/users/${second}`, { cookie, body: { disabled: true } })).status).toBe(
      200,
    );
    const [assignment] = await t.db.select().from(roleAssignments).where(eq(roleAssignments.userId, second));
    expect((await app.request('DELETE', `/api/v1/users/${second}/roles/${assignment?.id}`, { cookie })).status).toBe(
      204,
    );
  });

  test('two org admins disabling each other leave one enabled', async () => {
    // Guard'ni chetlab, ikkala so'rov ham tekshiruvdan o'tgan paytdagi poyga service darajasida.
    const second = await seedUser(t.db, a.orgId, 'a-admin2', [{ role: 'school_admin', siteId: null }]);
    const audit = new AuditWriter();
    const service = new UsersService(
      t.db,
      Date.now,
      new Access(t.db, audit),
      audit,
      new SessionService(t.db, { now: Date.now, idleMs: 7_200_000, absoluteMs: 43_200_000 }),
    );
    const ctx = async (userId: string) => ({
      correlationId: `race-${userId.slice(0, 8)}`,
      clientIp: '127.0.0.1',
      actor: (await loadActor(t.db, userId))?.actor ?? null,
      sessionId: null,
    });
    const outcomes = await Promise.allSettled([
      service.setDisabled(await ctx(adminId), second, true),
      service.setDisabled(await ctx(second), adminId, true),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'conflict' });
    const enabledAdmins = (await t.db.select().from(users).where(isNull(users.disabledAt))).filter((u) =>
      u.username.startsWith('a-admin'),
    );
    expect(enabledAdmins).toHaveLength(1);
  });

  test('duplicate username is a conflict', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const res = await app.request('POST', '/api/v1/users', {
      cookie,
      body: newUser('A-Teacher', [{ role: 'teacher', siteId: a.siteId }]),
    });
    expect(res.status).toBe(409);
  });
});
