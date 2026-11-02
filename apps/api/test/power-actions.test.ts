import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, powerActions, powerActionTargets, sites } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { retireDevice, seedBoundDevice, setSiteDomain } from './support/power.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

const mesh = new FakeMesh();
let app: TestApp;
let orgId: string;
let siteId: string;
let otherSiteId: string;
let thirdSiteId: string;
let roomId: string;
let adminId: string;
let admin: string;
const NOW = Date.parse('2026-11-02T10:00:00Z');

beforeAll(async () => {
  app = await startTestApp({ deviceManagement: mesh.factory, mesh: { connected: true }, now: () => NOW });
});
beforeEach(async () => {
  mesh.nodes.clear();
  mesh.failing = false;
  await app.db.reset();
  ({ orgId, siteId, otherSiteId } = await seedOrg(app.db.db));
  const [third] = await app.db.db.insert(sites).values({ organizationId: orgId, name: 'Bino 3' }).returning();
  if (!third) throw new Error('seed site');
  thirdSiteId = third.id;
  await setSiteDomain(app.db.db, siteId, '');
  await setSiteDomain(app.db.db, otherSiteId, 'dom-b');
  await setSiteDomain(app.db.db, thirdSiteId, 'dom-c');
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  adminId = await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  admin = await loginAs(app, 'admin1');
});
afterAll(async () => {
  await app?.close();
});

const DOMAIN: Record<string, string> = {};
const bound = (site: string, opts: { room?: string; online?: boolean } = {}) => {
  DOMAIN[siteId] = '';
  DOMAIN[otherSiteId] = 'dom-b';
  DOMAIN[thirdSiteId] = 'dom-c';
  return seedBoundDevice(app.db.db, mesh, {
    orgId,
    siteId: site,
    roomId: opts.room,
    domain: DOMAIN[site] ?? '',
    boundBy: adminId,
    online: opts.online,
  });
};
const create = (body: unknown, cookie = admin, key = randomUUID()) =>
  app.request('POST', '/api/v1/power-actions', { body, cookie, headers: { 'idempotency-key': key } });
const targetsOf = (actionId: string) =>
  app.db.db.select().from(powerActionTargets).where(eq(powerActionTargets.actionId, actionId));
const auditOf = (action: string) => app.db.db.select().from(auditEvents).where(eq(auditEvents.action, action));

describe('power actions', () => {
  test('org admin shuts down the whole organization after confirming the count', async () => {
    for (const s of [siteId, otherSiteId, thirdSiteId]) {
      await bound(s);
      await bound(s);
    }
    const res = await create({ type: 'shutdown', scope: { kind: 'organization' }, confirmDeviceCount: 6 });
    expect(res.status).toBe(202);
    expect(res.json.status).toBe('running');
    expect(res.json.summary.pending).toBe(6);
    const targets = await targetsOf(res.json.id);
    expect(targets).toHaveLength(6);
    expect(targets.every((t) => t.status === 'pending')).toBe(true);
    const [audit] = await auditOf('power.request');
    expect(audit?.details).toMatchObject({ type: 'shutdown', deviceCount: 6 });
  });

  test('a stale confirmation count is rejected', async () => {
    for (let i = 0; i < 6; i++) await bound(siteId);
    const res = await create({ type: 'shutdown', scope: { kind: 'organization' }, confirmDeviceCount: 5 });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('confirmation_required');
    const missing = await create({ type: 'shutdown', scope: { kind: 'organization' } });
    expect(missing.json.error.code).toBe('confirmation_required');
    expect(await app.db.db.select().from(powerActions)).toHaveLength(0);
  });

  test('a single device needs no confirmation', async () => {
    const { deviceId } = await bound(siteId);
    const res = await create({ type: 'reboot', scope: { kind: 'devices', deviceIds: [deviceId] } });
    expect(res.status).toBe(202);
    expect(res.json.summary.pending).toBe(1);
  });

  test('zero devices in scope is a conflict', async () => {
    const res = await create({ type: 'shutdown', scope: { kind: 'sites', siteIds: [thirdSiteId] } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
  });

  test('site it_support may target its own site and not another', async () => {
    await seedUser(app.db.db, orgId, 'it1', [{ role: 'it_support', siteId }]);
    const it = await loginAs(app, 'it1');
    const own = await bound(siteId, { room: roomId });
    const foreign = await bound(otherSiteId);
    expect((await create({ type: 'sleep', scope: { kind: 'rooms', roomIds: [roomId] } }, it)).status).toBe(202);
    const denied = await create({ type: 'sleep', scope: { kind: 'devices', deviceIds: [foreign.deviceId] } }, it);
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('scope_denied');
    const unknown = await create({ type: 'sleep', scope: { kind: 'devices', deviceIds: [randomUUID()] } }, it);
    expect(unknown.status).toBe(403);
    const mixed = await create(
      { type: 'sleep', scope: { kind: 'devices', deviceIds: [own.deviceId, foreign.deviceId] }, confirmDeviceCount: 2 },
      it,
    );
    expect(mixed.status).toBe(403);
    const denials = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'power.manage'), eq(auditEvents.result, 'denied')));
    expect(denials.length).toBeGreaterThanOrEqual(3);
  });

  test('teacher may not manage power', async () => {
    await seedUser(app.db.db, orgId, 't1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    const teacher = await loginAs(app, 't1');
    await bound(siteId, { room: roomId });
    const res = await create({ type: 'shutdown', scope: { kind: 'rooms', roomIds: [roomId] } }, teacher);
    expect(res.status).toBe(403);
  });

  test('organization scope needs an org admin', async () => {
    await seedUser(app.db.db, orgId, 'sa', [{ role: 'school_admin', siteId }]);
    const siteAdmin = await loginAs(app, 'sa');
    await bound(siteId);
    const res = await create({ type: 'shutdown', scope: { kind: 'organization' }, confirmDeviceCount: 1 }, siteAdmin);
    expect(res.status).toBe(403);
    expect((await create({ type: 'shutdown', scope: { kind: 'sites', siteIds: [siteId] } }, siteAdmin)).status).toBe(
      202,
    );
  });

  test('unbound devices fail as unbound and retired devices are not targeted', async () => {
    const a = await bound(siteId);
    const unboundId = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey);
    const retired = await bound(siteId);
    await retireDevice(app.db.db, retired.deviceId);
    const res = await create({ type: 'shutdown', scope: { kind: 'sites', siteIds: [siteId] }, confirmDeviceCount: 2 });
    expect(res.status).toBe(202);
    const targets = await targetsOf(res.json.id);
    expect(targets.map((t) => [t.deviceId, t.status, t.reason]).sort()).toEqual(
      [
        [a.deviceId, 'pending', null],
        [unboundId, 'failed', 'unbound'],
      ].sort(),
    );
  });

  test('preview counts devices and agent state', async () => {
    await bound(siteId, { online: true });
    await bound(siteId, { online: false });
    await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey);
    const scope = { kind: 'sites', siteIds: [siteId] };
    const res = await app.request('POST', '/api/v1/power-actions/preview', {
      body: { type: 'shutdown', scope },
      cookie: admin,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ deviceCount: 3, unbound: 1, agentOnline: 1, agentOffline: 1 });
    mesh.failing = true;
    const down = await app.request('POST', '/api/v1/power-actions/preview', {
      body: { type: 'shutdown', scope },
      cookie: admin,
    });
    expect(down.json).toEqual({ deviceCount: 3, unbound: 1, agentOnline: null, agentOffline: null });
  });

  test('the same Idempotency-Key returns the same action', async () => {
    const { deviceId } = await bound(siteId);
    const key = randomUUID();
    const body = { type: 'reboot', scope: { kind: 'devices', deviceIds: [deviceId] } };
    const first = await create(body, admin, key);
    const second = await create(body, admin, key);
    expect(second.json.id).toBe(first.json.id);
    expect(await app.db.db.select().from(powerActions)).toHaveLength(1);
  });

  test('a future runAt is scheduled without targets; more than 30 days ahead is a validation error', async () => {
    const { deviceId } = await bound(siteId);
    const scope = { kind: 'devices', deviceIds: [deviceId] };
    const later = new Date(NOW + 3_600_000).toISOString();
    const res = await create({ type: 'shutdown', scope, runAt: later });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ status: 'scheduled', runAt: later });
    expect(await targetsOf(res.json.id)).toHaveLength(0);
    const tooFar = await create({ type: 'shutdown', scope, runAt: new Date(NOW + 31 * 86_400_000).toISOString() });
    expect(tooFar.status).toBe(400);
    expect(tooFar.json.error.code).toBe('validation_failed');
  });

  test('cancelling a scheduled action and a running one', async () => {
    const { deviceId } = await bound(siteId);
    const scope = { kind: 'devices', deviceIds: [deviceId] };
    const scheduled = await create({ type: 'shutdown', scope, runAt: new Date(NOW + 60_000).toISOString() });
    const c1 = await app.request('POST', `/api/v1/power-actions/${scheduled.json.id}/cancel`, { cookie: admin });
    expect(c1.status).toBe(200);
    expect(c1.json.status).toBe('cancelled');

    const running = await create({ type: 'shutdown', scope });
    const c2 = await app.request('POST', `/api/v1/power-actions/${running.json.id}/cancel`, { cookie: admin });
    expect(c2.json.summary).toMatchObject({ pending: 0, cancelled: 1 });
    const again = await app.request('POST', `/api/v1/power-actions/${running.json.id}/cancel`, { cookie: admin });
    expect(again.status).toBe(200);
    expect(await auditOf('power.cancel')).toHaveLength(3);
  });

  test('list hides actions on sites the actor cannot manage', async () => {
    await seedUser(app.db.db, orgId, 'it1', [{ role: 'it_support', siteId }]);
    const it = await loginAs(app, 'it1');
    const own = await bound(siteId);
    const foreign = await bound(otherSiteId);
    await create({ type: 'reboot', scope: { kind: 'devices', deviceIds: [own.deviceId] } });
    const other = await create({ type: 'reboot', scope: { kind: 'devices', deviceIds: [foreign.deviceId] } });
    await bound(thirdSiteId);
    await create({ type: 'reboot', scope: { kind: 'organization' }, confirmDeviceCount: 3 });
    const list = await app.request('GET', '/api/v1/power-actions', { cookie: it });
    expect(list.status).toBe(200);
    expect(list.json.actions).toHaveLength(1);
    expect((await app.request('GET', '/api/v1/power-actions', { cookie: admin })).json.actions).toHaveLength(3);
    const detail = await app.request('GET', `/api/v1/power-actions/${other.json.id}`, { cookie: it });
    expect(detail.status).toBe(403);
    const mine = await app.request('GET', `/api/v1/power-actions/${list.json.actions[0].id}`, { cookie: it });
    expect(mine.json.targets).toHaveLength(1);
    expect(mine.json.targets[0]).toMatchObject({ deviceId: own.deviceId, hostname: 'pc-01', status: 'pending' });
  });
  test('a runAt older than the grace is rejected', async () => {
    const { deviceId } = await bound(siteId);
    const scope = { kind: 'devices', deviceIds: [deviceId] };
    const stale = await create({ type: 'reboot', scope, runAt: new Date(NOW - 11 * 60_000).toISOString() });
    expect(stale.status).toBe(400);
    expect(stale.json.error.code).toBe('validation_failed');
    const recent = await create({ type: 'reboot', scope, runAt: new Date(NOW - 60_000).toISOString() });
    expect(recent.status).toBe(202);
    expect(recent.json.status).toBe('running');
  });

  test('an organization action with thousands of devices is created', async () => {
    await app.db.db.execute(sql`
      insert into devices (organization_id, site_id, hostname, public_key, key_fingerprint)
      select ${orgId}, ${siteId}, 'bulk-' || g, convert_to('bulk-key-' || g, 'UTF8'), 'bulk-fp-' || g
      from generate_series(1, 9000) as g`);
    const res = await create({ type: 'shutdown', scope: { kind: 'organization' }, confirmDeviceCount: 9000 });
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    expect(res.json.summary.failed).toBe(9000);
  });

  test('list shows a site admin their own actions beyond the newest 500 of the organization', async () => {
    await seedUser(app.db.db, orgId, 'it1', [{ role: 'it_support', siteId }]);
    const it = await loginAs(app, 'it1');
    const own = await bound(siteId);
    const mine = await create({ type: 'reboot', scope: { kind: 'devices', deviceIds: [own.deviceId] } });
    expect(mine.status).toBe(202);
    await app.db.db.execute(sql`
      insert into power_actions (organization_id, type, scope, site_ids, status, run_at, created_at)
      select ${orgId}, 'shutdown', '{"kind":"organization"}'::jsonb, array[${otherSiteId}]::uuid[], 'completed',
             now(), ${new Date(NOW + 60_000)}::timestamptz + (g || ' seconds')::interval
      from generate_series(1, 600) as g`);
    const list = await app.request('GET', '/api/v1/power-actions?limit=10', { cookie: it });
    expect(list.json.actions.map((a: { id: string }) => a.id)).toEqual([mine.json.id]);
  });
});
