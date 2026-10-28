import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { roleAssignments, users } from '../src/db/schema.ts';
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

  test('duplicate username is a conflict', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const res = await app.request('POST', '/api/v1/users', {
      cookie,
      body: newUser('A-Teacher', [{ role: 'teacher', siteId: a.siteId }]),
    });
    expect(res.status).toBe(409);
  });
});
