import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, rooms } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { createTestDb, type TestDb } from './support/db.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let t: TestDb;
let app: TestApp;
let a: { orgId: string; siteId: string; otherSiteId: string };
let roomA1: string;
let roomA2: string;
let roomB: string;
let teacherId: string;
let otherTeacherId: string;
let studentId: string;

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
  roomA1 = await seedRoom(t.db, a.orgId, a.siteId, '101');
  roomA2 = await seedRoom(t.db, a.orgId, a.siteId, '102');
  roomB = await seedRoom(t.db, b.orgId, b.siteId, '201');
  await seedUser(t.db, a.orgId, 'a-admin', [{ role: 'school_admin', siteId: null }]);
  await seedUser(t.db, a.orgId, 'a-site-admin', [{ role: 'school_admin', siteId: a.siteId }]);
  await seedUser(t.db, a.orgId, 'a-it', [{ role: 'it_support', siteId: a.siteId }]);
  teacherId = await seedUser(t.db, a.orgId, 'a-teacher', [{ role: 'teacher', siteId: a.siteId }], {
    roomIds: [roomA1],
  });
  otherTeacherId = await seedUser(t.db, a.orgId, 'a-teacher2', [{ role: 'teacher', siteId: a.siteId }]);
  studentId = await seedUser(t.db, a.orgId, 'a-student', [{ role: 'student', siteId: a.siteId }]);
  await seedUser(t.db, b.orgId, 'b-admin', [{ role: 'school_admin', siteId: null }]);
});

const names = (list: { name: string }[]) => list.map((x) => x.name).sort();

describe('sites and rooms', () => {
  test('org admin creates sites and rooms', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const site = await app.request('POST', '/api/v1/sites', { cookie, body: { name: 'Bino C' } });
    expect(site.status).toBe(201);
    expect(site.json).toMatchObject({ name: 'Bino C' });
    const room = await app.request('POST', `/api/v1/sites/${site.json.id}/rooms`, { cookie, body: { name: '301' } });
    expect(room.status).toBe(201);
    expect(room.json).toMatchObject({ siteId: site.json.id, name: '301' });
    const list = await app.request('GET', '/api/v1/sites', { cookie });
    expect(names(list.json.sites)).toEqual(['A bino A', 'A bino B', 'Bino C']);
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'room.create'));
    expect(audit).toEqual([
      expect.objectContaining({ result: 'succeeded', organizationId: a.orgId, targetId: room.json.id }),
    ]);
  });

  test('site admin manages rooms only in own site', async () => {
    const cookie = await loginAs(app, 'a-site-admin');
    expect((await app.request('POST', '/api/v1/sites', { cookie, body: { name: 'X' } })).status).toBe(403);
    expect(
      (await app.request('POST', `/api/v1/sites/${a.siteId}/rooms`, { cookie, body: { name: '103' } })).status,
    ).toBe(201);
    expect(
      (await app.request('POST', `/api/v1/sites/${a.otherSiteId}/rooms`, { cookie, body: { name: '1' } })).status,
    ).toBe(403);
    expect((await app.request('PATCH', `/api/v1/rooms/${roomA2}`, { cookie, body: { name: '102a' } })).status).toBe(
      200,
    );
    const sites = await app.request('GET', '/api/v1/sites', { cookie });
    expect(names(sites.json.sites)).toEqual(['A bino A']);
  });

  test('teacher lists only assigned rooms', async () => {
    const cookie = await loginAs(app, 'a-teacher');
    const res = await app.request('GET', `/api/v1/sites/${a.siteId}/rooms`, { cookie });
    expect(res.status).toBe(200);
    expect(res.json.rooms.map((r: { id: string }) => r.id)).toEqual([roomA1]);
  });

  test('it support reads rooms but cannot change them', async () => {
    const cookie = await loginAs(app, 'a-it');
    const res = await app.request('GET', `/api/v1/sites/${a.siteId}/rooms`, { cookie });
    expect(names(res.json.rooms)).toEqual(['101', '102']);
    expect((await app.request('PATCH', `/api/v1/rooms/${roomA1}`, { cookie, body: { name: 'z' } })).status).toBe(403);
    expect((await app.request('POST', `/api/v1/sites/${a.siteId}/rooms`, { cookie, body: { name: 'z' } })).status).toBe(
      403,
    );
  });

  test('student cannot list rooms or sites', async () => {
    const cookie = await loginAs(app, 'a-student');
    expect((await app.request('GET', `/api/v1/sites/${a.siteId}/rooms`, { cookie })).status).toBe(403);
    expect((await app.request('GET', '/api/v1/sites', { cookie })).json.sites).toEqual([]);
  });

  test('cross-organization room update is denied and audited', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const res = await app.request('PATCH', `/api/v1/rooms/${roomB}`, { cookie, body: { name: 'hacked' } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('scope_denied');
    const [room] = await t.db.select().from(rooms).where(eq(rooms.id, roomB));
    expect(room?.name).toBe('201');
    const denied = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'room.update'), eq(auditEvents.result, 'denied')));
    expect(denied).toEqual([
      expect.objectContaining({
        organizationId: a.orgId,
        targetId: roomB,
        correlationId: res.json.error.correlationId,
      }),
    ]);
    const listForeign = await app.request('POST', `/api/v1/sites/${(await seedOrg(t.db, 'C')).siteId}/rooms`, {
      cookie,
      body: { name: 'x' },
    });
    expect(listForeign.status).toBe(403);
  });

  test('unknown and foreign room ids look the same (403)', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const foreign = await app.request('PATCH', `/api/v1/rooms/${roomB}`, { cookie, body: { name: 'n' } });
    const unknown = await app.request('PATCH', '/api/v1/rooms/00000000-0000-4000-8000-000000000000', {
      cookie,
      body: { name: 'n' },
    });
    const garbage = await app.request('PATCH', '/api/v1/rooms/not-a-uuid', { cookie, body: { name: 'n' } });
    for (const r of [foreign, unknown, garbage]) {
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('scope_denied');
    }
  });

  test('duplicate room name in a site is a conflict', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const res = await app.request('POST', `/api/v1/sites/${a.siteId}/rooms`, { cookie, body: { name: '101' } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
  });

  test('invalid room body is a validation error', async () => {
    const cookie = await loginAs(app, 'a-admin');
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'ok', extra: 1 }]) {
      expect((await app.request('POST', `/api/v1/sites/${a.siteId}/rooms`, { cookie, body })).status).toBe(400);
    }
  });
});

describe('teacher assignment', () => {
  test('site admin assigns and removes a teacher', async () => {
    const cookie = await loginAs(app, 'a-site-admin');
    expect((await app.request('PUT', `/api/v1/rooms/${roomA2}/teachers/${otherTeacherId}`, { cookie })).status).toBe(
      204,
    );
    const teacher = await loginAs(app, 'a-teacher2');
    const visible = await app.request('GET', `/api/v1/sites/${a.siteId}/rooms`, { cookie: teacher });
    expect(visible.json.rooms.map((r: { id: string }) => r.id)).toEqual([roomA2]);
    expect((await app.request('DELETE', `/api/v1/rooms/${roomA2}/teachers/${otherTeacherId}`, { cookie })).status).toBe(
      204,
    );
    const again = await app.request('GET', `/api/v1/sites/${a.siteId}/rooms`, { cookie: teacher });
    expect(again.json.rooms).toEqual([]);
  });

  test('assigning a non-teacher to a room is a conflict', async () => {
    const cookie = await loginAs(app, 'a-admin');
    const res = await app.request('PUT', `/api/v1/rooms/${roomA1}/teachers/${studentId}`, { cookie });
    expect(res.status).toBe(409);
  });

  test('teacher cannot assign teachers', async () => {
    const cookie = await loginAs(app, 'a-teacher');
    expect((await app.request('PUT', `/api/v1/rooms/${roomA1}/teachers/${teacherId}`, { cookie })).status).toBe(403);
  });
});
