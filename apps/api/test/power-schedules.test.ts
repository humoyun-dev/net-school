import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, powerActions, powerActionTargets, powerSchedules } from '../src/db/schema.ts';
import { PowerWorker } from '../src/modules/power/power.worker.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { retireDevice, seedBoundDevice, setSiteDomain } from './support/power.ts';
import { seedOrg, seedUser } from './support/seed.ts';

// Dushanba 18:00 Toshkent vaqti.
const T0 = Date.parse('2026-11-02T13:00:00Z');
const MON_19 = Date.parse('2026-11-02T14:00:00Z');
const TUE_19 = Date.parse('2026-11-03T14:00:00Z');
const rule = { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '19:00', timezone: 'Asia/Tashkent' };
let now = T0;
const mesh = new FakeMesh();
let app: TestApp;
let orgId: string;
let siteId: string;
let otherSiteId: string;
let adminId: string;
let admin: string;

beforeAll(async () => {
  app = await startTestApp({ deviceManagement: mesh.factory, mesh: { connected: true }, now: () => now });
});
beforeEach(async () => {
  now = T0;
  mesh.nodes.clear();
  mesh.powerRequests.length = 0;
  await app.db.reset();
  ({ orgId, siteId, otherSiteId } = await seedOrg(app.db.db));
  await setSiteDomain(app.db.db, siteId, '');
  await setSiteDomain(app.db.db, otherSiteId, 'dom-b');
  adminId = await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  admin = await loginAs(app, 'admin1');
});
afterAll(async () => {
  await app?.close();
});

const worker = () => app.get<PowerWorker>(PowerWorker);
const bound = (site = siteId) =>
  seedBoundDevice(app.db.db, mesh, { orgId, siteId: site, domain: site === siteId ? '' : 'dom-b', boundBy: adminId });
async function schedule(count: number, site = siteId, cookie = admin) {
  return app.request('POST', '/api/v1/power-schedules', {
    body: { type: 'shutdown', scope: { kind: 'sites', siteIds: [site] }, rule, confirmDeviceCount: count },
    cookie,
    headers: { 'idempotency-key': randomUUID() },
  });
}
const actionsOf = (scheduleId: string) =>
  app.db.db.select().from(powerActions).where(eq(powerActions.scheduleId, scheduleId));

describe('power schedules', () => {
  test('creating a schedule computes the next run in its timezone', async () => {
    await bound();
    await bound();
    const res = await schedule(2);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({ enabled: true, nextRunAt: new Date(MON_19).toISOString(), rule });
    const [audit] = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'power.schedule_create'));
    expect(audit?.targetId).toBe(res.json.id);
    expect((await schedule(3)).json.error.code).toBe('confirmation_required');
  });

  test('a due schedule creates one running action and advances', async () => {
    await bound();
    const { json } = await schedule(1);
    now = MON_19 + 2_000;
    await worker().tick(now);
    const [action] = await actionsOf(json.id);
    expect(action).toMatchObject({ status: 'running', requestedBy: null });
    expect(action?.runAt.getTime()).toBe(MON_19);
    expect(mesh.powerRequests).toHaveLength(1);
    const [row] = await app.db.db.select().from(powerSchedules).where(eq(powerSchedules.id, json.id));
    expect(row?.nextRunAt?.getTime()).toBe(TUE_19);
  });

  test('two ticks create one action per occurrence', async () => {
    await bound();
    const { json } = await schedule(1);
    now = MON_19;
    await Promise.all([worker().tick(now), worker().tick(now)]);
    await worker().tick(now + 1);
    expect(await actionsOf(json.id)).toHaveLength(1);
  });

  test('a schedule missed by more than the grace is skipped, not run late', async () => {
    await bound();
    const { json } = await schedule(1);
    now = MON_19 + 11 * 60_000;
    await worker().tick(now);
    const [action] = await actionsOf(json.id);
    expect(action).toMatchObject({ status: 'missed' });
    expect(mesh.powerRequests).toHaveLength(0);
    expect(await app.db.db.select().from(powerActionTargets)).toHaveLength(0);
    const [row] = await app.db.db.select().from(powerSchedules).where(eq(powerSchedules.id, json.id));
    expect(row?.nextRunAt?.getTime()).toBe(TUE_19);
    const missed = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'power.missed'));
    expect(missed).toHaveLength(1);
  });

  test('a scheduled run targets the current devices of its scope', async () => {
    const a = await bound();
    const b = await bound();
    const { json } = await schedule(2);
    await retireDevice(app.db.db, a.deviceId);
    const c = await bound();
    now = MON_19;
    await worker().tick(now);
    const [action] = await actionsOf(json.id);
    const targets = await app.db.db
      .select()
      .from(powerActionTargets)
      .where(eq(powerActionTargets.actionId, action?.id ?? ''));
    expect(targets.map((t) => t.deviceId).sort()).toEqual([b.deviceId, c.deviceId].sort());
  });

  test('disabling clears the next run; re-enabling recomputes it', async () => {
    await bound();
    const { json } = await schedule(1);
    const off = await app.request('PATCH', `/api/v1/power-schedules/${json.id}`, {
      body: { enabled: false },
      cookie: admin,
    });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ enabled: false, nextRunAt: null });
    now = MON_19 + 1_000;
    await worker().tick(now);
    expect(await actionsOf(json.id)).toHaveLength(0);
    const on = await app.request('PATCH', `/api/v1/power-schedules/${json.id}`, {
      body: { enabled: true },
      cookie: admin,
    });
    expect(on.json).toMatchObject({ enabled: true, nextRunAt: new Date(TUE_19).toISOString() });
    const moved = await app.request('PATCH', `/api/v1/power-schedules/${json.id}`, {
      body: { rule: { ...rule, timeOfDay: '20:30' } },
      cookie: admin,
    });
    expect(moved.json.nextRunAt).toBe(new Date(Date.parse('2026-11-02T15:30:00Z')).toISOString());
    const del = await app.request('DELETE', `/api/v1/power-schedules/${json.id}`, { cookie: admin });
    expect(del.status).toBe(204);
    expect((await app.request('GET', '/api/v1/power-schedules', { cookie: admin })).json.schedules).toHaveLength(0);
  });

  test("site it_support cannot see or change another site's schedule", async () => {
    await seedUser(app.db.db, orgId, 'it1', [{ role: 'it_support', siteId }]);
    const it = await loginAs(app, 'it1');
    await bound();
    await bound(otherSiteId);
    const own = await schedule(1, siteId, it);
    expect(own.status).toBe(201);
    const foreign = await schedule(1, otherSiteId);
    const list = await app.request('GET', '/api/v1/power-schedules', { cookie: it });
    expect(list.json.schedules.map((s: { id: string }) => s.id)).toEqual([own.json.id]);
    const patch = await app.request('PATCH', `/api/v1/power-schedules/${foreign.json.id}`, {
      body: { enabled: false },
      cookie: it,
    });
    expect(patch.status).toBe(403);
    expect((await app.request('DELETE', `/api/v1/power-schedules/${foreign.json.id}`, { cookie: it })).status).toBe(
      403,
    );
    expect((await schedule(1, otherSiteId, it)).status).toBe(403);
    const denials = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'power.manage'), eq(auditEvents.result, 'denied')));
    expect(denials).toHaveLength(3);
  });
  test('one failing due schedule does not block the others', async () => {
    await bound();
    const good = await schedule(1);
    const bad = await schedule(1);
    // Buzilgan vaqt mintaqasi (masalan, ICU yangilanishidan keyin): nextOccurrence xato beradi.
    await app.db.db.update(powerSchedules).set({ timezone: 'Mars/Base' }).where(eq(powerSchedules.id, bad.json.id));
    now = MON_19;
    await worker().tick(now);
    expect(await actionsOf(good.json.id)).toHaveLength(1);
  });
});
