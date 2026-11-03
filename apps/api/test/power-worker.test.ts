import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, powerActions, powerActionTargets } from '../src/db/schema.ts';
import { PowerWorker } from '../src/modules/power/power.worker.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { seedBoundDevice, setSiteDomain } from './support/power.ts';
import { seedOrg, seedUser } from './support/seed.ts';

const T0 = Date.parse('2026-11-02T10:00:00Z');
let now = T0;
const mesh = new FakeMesh();
const link = { connected: true };
let app: TestApp;
let orgId: string;
let siteId: string;
let otherSiteId: string;
let adminId: string;
let admin: string;

beforeAll(async () => {
  app = await startTestApp({ deviceManagement: mesh.factory, mesh: link, now: () => now });
});
beforeEach(async () => {
  now = T0;
  link.connected = true;
  mesh.nodes.clear();
  mesh.powerRequests.length = 0;
  mesh.forcedRequests.length = 0;
  mesh.wakeResults.clear();
  mesh.powerFailing = false;
  mesh.failing = false;
  mesh.failingDomains.clear();
  mesh.listCalls.clear();
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

const worker = (a: TestApp = app) => a.get<PowerWorker>(PowerWorker);
const bound = (online = true, site = siteId) =>
  seedBoundDevice(app.db.db, mesh, {
    orgId,
    siteId: site,
    domain: site === siteId ? '' : 'dom-b',
    boundBy: adminId,
    online,
  });
async function act(type: string, count: number, extra: Record<string, unknown> = {}) {
  const res = await app.request('POST', '/api/v1/power-actions', {
    body: { type, scope: { kind: 'sites', siteIds: [siteId] }, confirmDeviceCount: count, ...extra },
    cookie: admin,
    headers: { 'idempotency-key': randomUUID() },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  return res.json.id as string;
}
const targets = async (actionId: string) =>
  app.db.db.select().from(powerActionTargets).where(eq(powerActionTargets.actionId, actionId));
const target = async (actionId: string) => (await targets(actionId))[0];
const actionRow = async (id: string) => (await app.db.db.select().from(powerActions).where(eq(powerActions.id, id)))[0];
const setOnline = (nodeId: string, online: boolean) => {
  const n = mesh.nodes.get(nodeId);
  if (n) n.online = online;
};

describe('power worker', () => {
  test('a running action sends in waves of 50 every 5 seconds', async () => {
    for (let i = 0; i < 120; i++) await bound();
    await act('shutdown', 120);
    await worker().tick(T0);
    expect(mesh.powerRequests).toHaveLength(50);
    await worker().tick(T0 + 1_000);
    expect(mesh.powerRequests).toHaveLength(50);
    await worker().tick(T0 + 5_000);
    expect(mesh.powerRequests).toHaveLength(100);
    await worker().tick(T0 + 10_000);
    expect(mesh.powerRequests).toHaveLength(120);
    expect(new Set(mesh.powerRequests.map((r) => r.nodeId)).size).toBe(120);
  });

  test('shutdown succeeds when the agent goes offline and the action completes', async () => {
    const d = await bound();
    const id = await act('shutdown', 1);
    await worker().tick(T0);
    expect(await target(id)).toMatchObject({ status: 'sent' });
    expect(mesh.powerRequests).toEqual([{ siteId, nodeId: d.nodeId, type: 'shutdown' }]);
    setOnline(d.nodeId, false);
    await worker().tick(T0 + 5_000);
    expect(await target(id)).toMatchObject({ status: 'succeeded' });
    expect(await actionRow(id)).toMatchObject({ status: 'completed' });
    const [audit] = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'power.completed'));
    expect(audit).toMatchObject({ actorUserId: null, targetId: id });
    expect(audit?.details).toMatchObject({ succeeded: 1 });
  });

  test('reboot succeeds only after offline then online', async () => {
    const d = await bound();
    const id = await act('reboot', 1);
    await worker().tick(T0);
    await worker().tick(T0 + 5_000);
    expect(await target(id)).toMatchObject({ status: 'sent', offlineSeenAt: null });
    setOnline(d.nodeId, false);
    await worker().tick(T0 + 10_000);
    expect(await target(id)).toMatchObject({ status: 'sent' });
    expect((await target(id))?.offlineSeenAt).not.toBeNull();
    setOnline(d.nodeId, true);
    await worker().tick(T0 + 40_000);
    expect(await target(id)).toMatchObject({ status: 'succeeded' });
  });

  // P0c: Windows'da ochiq dastur yumshoq o'chirishni to'sib qo'ydi. 60 s dan keyin ham onlayn — bir marta majburiy.
  test('a shutdown still online after 60 s is forced once, recorded and audited', async () => {
    const d = await bound();
    const node = mesh.nodes.get(d.nodeId);
    if (node) node.os = 'Microsoft Windows 11 Pro - 23H2/22631';
    const id = await act('shutdown', 1);
    await worker().tick(T0);
    await worker().tick(T0 + 59_000);
    expect(mesh.forcedRequests).toEqual([]);
    await worker().tick(T0 + 60_000);
    expect(mesh.forcedRequests).toEqual([{ siteId, nodeId: d.nodeId, type: 'shutdown', platform: 'windows' }]);
    expect((await target(id))?.forcedAt?.getTime()).toBe(T0 + 60_000);
    await worker().tick(T0 + 61_000);
    await worker().tick(T0 + 90_000);
    expect(mesh.forcedRequests).toHaveLength(1);
    setOnline(d.nodeId, false);
    await worker().tick(T0 + 95_000);
    expect(await target(id)).toMatchObject({ status: 'succeeded' });
    expect((await target(id))?.forcedAt?.getTime()).toBe(T0 + 60_000);
    const [audit] = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'power.forced'));
    expect(audit).toMatchObject({ actorUserId: null, targetId: id });
    expect(audit?.details).toMatchObject({ type: 'shutdown', deviceId: d.deviceId, platform: 'windows' });
    // Admin natijada qaysi kompyuter majburan o'chirilganini ko'radi.
    const res = await app.request('GET', `/api/v1/power-actions/${id}`, { cookie: admin });
    expect(res.json.targets[0]).toMatchObject({ status: 'succeeded', forcedAt: new Date(T0 + 60_000).toISOString() });
  });

  test('a device that shuts down within 60 s is never forced', async () => {
    const quick = await bound();
    const id = await act('shutdown', 1);
    await worker().tick(T0);
    setOnline(quick.nodeId, false);
    await worker().tick(T0 + 30_000);
    await worker().tick(T0 + 70_000);
    expect(await target(id)).toMatchObject({ status: 'succeeded', forcedAt: null });
    expect(mesh.forcedRequests).toEqual([]);
  });

  test('sleep and devices with an unknown OS are never forced', async () => {
    const d = await bound();
    const sleep = await act('sleep', 1);
    await worker().tick(T0);
    await worker().tick(T0 + 70_000);
    expect((await target(sleep))?.forcedAt).toBeNull();
    const node = mesh.nodes.get(d.nodeId);
    if (node) node.os = null;
    now = T0 + 200_000;
    const shutdown = await act('shutdown', 1);
    await worker().tick(T0 + 200_000);
    await worker().tick(T0 + 270_000);
    expect((await target(shutdown))?.forcedAt).toBeNull();
    expect(mesh.forcedRequests).toEqual([]);
  });

  test('a forced reboot is sent with the platform command and a failure is not retried', async () => {
    await bound();
    mesh.powerFailing = false;
    const id = await act('reboot', 1);
    await worker().tick(T0);
    mesh.powerFailing = true;
    await worker().tick(T0 + 60_000);
    mesh.powerFailing = false;
    await worker().tick(T0 + 70_000);
    // Ko'pi bilan bir marta: xato bo'lsa ham forcedAt yoziladi, qayta yuborilmaydi (reboot ikki marta bo'lmaydi).
    expect((await target(id))?.forcedAt?.getTime()).toBe(T0 + 60_000);
    expect(mesh.forcedRequests).toEqual([]);
  });

  test('an accepted request with no observed change ends unknown', async () => {
    await bound();
    const id = await act('reboot', 1);
    await worker().tick(T0);
    await worker().tick(T0 + 599_000);
    expect(await target(id)).toMatchObject({ status: 'sent' });
    await worker().tick(T0 + 600_000);
    expect(await target(id)).toMatchObject({ status: 'unknown' });
    expect(await actionRow(id)).toMatchObject({ status: 'completed' });
  });

  test('offline devices fail as device_offline at send time; wake skips devices already on as succeeded', async () => {
    const off = await bound(false);
    const id = await act('shutdown', 1);
    await worker().tick(T0);
    expect(await target(id)).toMatchObject({ status: 'failed', reason: 'device_offline' });

    const on = await bound(true);
    const wake = await act('wake', 2);
    await worker().tick(T0 + 1);
    const byDevice = new Map((await targets(wake)).map((t) => [t.deviceId, t]));
    expect(byDevice.get(on.deviceId)).toMatchObject({ status: 'succeeded' });
    expect(byDevice.get(off.deviceId)).toMatchObject({ status: 'sent' });
    expect(mesh.powerRequests).toEqual([{ siteId, nodeId: off.nodeId, type: 'wake' }]);
  });

  test('wake on a device without MAC fails as wake_unsupported', async () => {
    const d = await bound(false);
    mesh.wakeResults.set(d.nodeId, { accepted: false, reason: 'wake_unsupported' });
    const id = await act('wake', 1);
    await worker().tick(T0);
    expect(await target(id)).toMatchObject({ status: 'failed', reason: 'wake_unsupported' });
  });

  test('a restarted worker never resends a sent target', async () => {
    await bound();
    const id = await act('reboot', 1);
    mesh.powerFailing = true;
    await worker().tick(T0);
    expect(await target(id)).toMatchObject({ status: 'sent' });
    expect(mesh.powerRequests).toHaveLength(0);
    mesh.powerFailing = false;
    const restarted = await startTestApp({ db: app.db, deviceManagement: mesh.factory, mesh: link, now: () => now });
    try {
      await worker(restarted).tick(T0 + 5_000);
      await worker(restarted).tick(T0 + 10_000);
      expect(mesh.powerRequests).toHaveLength(0);
      expect(await target(id)).toMatchObject({ status: 'sent' });
    } finally {
      await restarted.close();
    }
  });

  test('nothing is sent while MeshCentral is disconnected and pending targets give up after 10 minutes', async () => {
    await bound();
    const id = await act('shutdown', 1);
    link.connected = false;
    await worker().tick(T0);
    await worker().tick(T0 + 599_999);
    expect(mesh.powerRequests).toHaveLength(0);
    expect(await target(id)).toMatchObject({ status: 'pending' });
    await worker().tick(T0 + 600_001);
    expect(await target(id)).toMatchObject({ status: 'failed', reason: 'upstream_unavailable' });
    link.connected = true;
    await worker().tick(T0 + 600_002);
    expect(mesh.powerRequests).toHaveLength(0);
    expect(await actionRow(id)).toMatchObject({ status: 'completed' });
  });

  test('a scheduled action starts at runAt; one late by more than the grace is missed', async () => {
    await bound();
    const runAt = new Date(T0 + 60_000).toISOString();
    const id = await act('shutdown', 1, { runAt });
    await worker().tick(T0 + 59_000);
    expect(await actionRow(id)).toMatchObject({ status: 'scheduled' });
    await worker().tick(T0 + 60_000);
    expect(await actionRow(id)).toMatchObject({ status: 'running' });
    expect(mesh.powerRequests).toHaveLength(1);

    const late = await act('reboot', 1, { runAt });
    await worker().tick(T0 + 60_000 + 600_001);
    expect(await actionRow(late)).toMatchObject({ status: 'missed' });
    expect(await targets(late)).toHaveLength(0);
    expect(mesh.powerRequests.filter((r) => r.type === 'reboot')).toHaveLength(0);
    const missed = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'power.missed'));
    expect(missed).toHaveLength(1);
  });
  test('an action left behind by a hub outage never sends late', async () => {
    await bound();
    const id = await act('reboot', 1);
    // Hub 3 soat ishlamadi: birinchi tick shundan keyin.
    await worker().tick(T0 + 3 * 3_600_000);
    expect(mesh.powerRequests).toHaveLength(0);
    expect(await target(id)).toMatchObject({ status: 'failed', reason: 'upstream_unavailable' });
  });

  test('a site whose snapshot fails holds only its own targets and gives up after 10 minutes', async () => {
    const a = await bound(true, siteId);
    const b = await bound(true, otherSiteId);
    mesh.failingDomains.add('dom-b');
    const res = await app.request('POST', '/api/v1/power-actions', {
      body: { type: 'shutdown', scope: { kind: 'organization' }, confirmDeviceCount: 2 },
      cookie: admin,
      headers: { 'idempotency-key': randomUUID() },
    });
    const id = res.json.id as string;
    await worker().tick(T0);
    expect(mesh.powerRequests.map((r) => r.nodeId)).toEqual([a.nodeId]);
    for (let t = T0 + 5_000; t <= T0 + 600_000; t += 60_000) await worker().tick(t);
    const byDevice = () => targets(id).then((rows) => new Map(rows.map((r) => [r.deviceId, r])));
    expect((await byDevice()).get(b.deviceId)).toMatchObject({ status: 'pending' });
    await worker().tick(T0 + 600_001);
    expect((await byDevice()).get(b.deviceId)).toMatchObject({ status: 'failed', reason: 'upstream_unavailable' });
    mesh.failingDomains.clear();
    await worker().tick(T0 + 700_000);
    expect(mesh.powerRequests.map((r) => r.nodeId)).toEqual([a.nodeId]);
  });

  test('a long action keeps sending past 10 minutes while waves progress', async () => {
    for (let i = 0; i < 3; i++) await bound();
    const id = await act('shutdown', 3);
    // To'lqinlar o'z vaqtida: kechikish runAt'dan emas, oxirgi to'lqindan hisoblanadi.
    await app.db.db
      .update(powerActions)
      .set({ nextWaveAt: new Date(T0 + 700_000) })
      .where(eq(powerActions.id, id));
    await worker().tick(T0 + 700_000);
    expect(mesh.powerRequests).toHaveLength(3);
  });

  test("a rejected wake does not touch another action's targets", async () => {
    const d = await bound(true);
    const shutdown = await act('shutdown', 1);
    await worker().tick(T0);
    expect(await target(shutdown)).toMatchObject({ status: 'sent' });
    // Kompyuter o'chdi; shu tick'da wake yuboriladi va rad etiladi, shutdown esa kuzatuvda succeeded bo'lishi kerak.
    setOnline(d.nodeId, false);
    mesh.wakeResults.set(d.nodeId, { accepted: false, reason: 'wake_unsupported' });
    const wake = await act('wake', 1);
    await worker().tick(T0 + 1);
    expect(await target(wake)).toMatchObject({ status: 'failed', reason: 'wake_unsupported' });
    expect(await target(shutdown)).toMatchObject({ status: 'succeeded', reason: null });
  });

  test('a wave stays within one site and one snapshot serves the whole tick', async () => {
    for (let i = 0; i < 30; i++) await bound(true, siteId);
    for (let i = 0; i < 30; i++) await bound(true, otherSiteId);
    const res = await app.request('POST', '/api/v1/power-actions', {
      body: { type: 'reboot', scope: { kind: 'organization' }, confirmDeviceCount: 60 },
      cookie: admin,
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(res.status).toBe(202);
    const first = [siteId, otherSiteId].sort()[0];
    await worker().tick(T0);
    const sites = mesh.powerRequests.map((r) => r.siteId);
    expect(sites.slice(0, 30).every((s) => s === first)).toBe(true);
    // Bitta tick: har site uchun ko'pi bilan bitta listDevices (claim va reconcile umumiy).
    expect([...mesh.listCalls.values()].every((n) => n === 1)).toBe(true);
  });
});
