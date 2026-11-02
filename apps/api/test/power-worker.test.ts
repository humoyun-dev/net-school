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
  mesh.wakeResults.clear();
  mesh.powerFailing = false;
  mesh.failing = false;
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  await setSiteDomain(app.db.db, siteId, '');
  adminId = await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  admin = await loginAs(app, 'admin1');
});
afterAll(async () => {
  await app?.close();
});

const worker = (a: TestApp = app) => a.get<PowerWorker>(PowerWorker);
const bound = (online = true) =>
  seedBoundDevice(app.db.db, mesh, { orgId, siteId, domain: '', boundBy: adminId, online });
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
});
