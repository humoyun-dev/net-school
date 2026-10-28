import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, devices, meshBindings, sites } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

const mesh = new FakeMesh();
let app: TestApp;
let orgId: string;
let siteId: string;
let otherSiteId: string;
let roomId: string;
let admin: string;

beforeAll(async () => {
  app = await startTestApp({ deviceManagement: mesh.factory });
});
beforeEach(async () => {
  mesh.nodes.clear();
  mesh.failing = false;
  await app.db.reset();
  ({ orgId, siteId, otherSiteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  admin = await loginAs(app, 'admin1');
});
afterAll(async () => {
  await app?.close();
});

const device = (site = siteId, room: string | null = roomId) =>
  seedDevice(app.db.db, orgId, site, makeDeviceKey().publicKey, { roomId: room ?? undefined });
const setDomain = (site: string, meshDomainId: string, cookie = admin) =>
  app.request('PUT', `/api/v1/sites/${site}/mesh-domain`, { body: { meshDomainId }, cookie });
const bind = (deviceId: string, meshNodeId: string, cookie = admin) =>
  app.request('PUT', `/api/v1/devices/${deviceId}/mesh-binding`, { body: { meshNodeId }, cookie });
const roomDevices = async () =>
  (await app.request('GET', `/api/v1/rooms/${roomId}/devices`, { cookie: admin })).json.devices as {
    id: string;
    agent: string;
  }[];

describe('mesh binding', () => {
  test('mesh binding requires a configured site domain', async () => {
    const d = await device();
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: true });
    const res = await bind(d, 'node-A');
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('capability_unavailable');

    const bare = await startTestApp({ db: app.db, deviceManagement: null });
    try {
      const cookie = await loginAs(bare, 'admin1');
      expect(
        (await bare.request('PUT', `/api/v1/sites/${siteId}/mesh-domain`, { body: { meshDomainId: '' }, cookie }))
          .status,
      ).toBe(200);
      const res2 = await bare.request('PUT', `/api/v1/devices/${d}/mesh-binding`, {
        body: { meshNodeId: 'node-A' },
        cookie,
      });
      expect(res2.status).toBe(409);
      expect(res2.json.error.code).toBe('capability_unavailable');
    } finally {
      await bare.close();
    }
  });

  test('only an organization admin sets the mesh domain', async () => {
    await seedUser(app.db.db, orgId, 'siteadmin', [{ role: 'school_admin', siteId }]);
    const siteAdmin = await loginAs(app, 'siteadmin');
    expect((await setDomain(siteId, '', siteAdmin)).status).toBe(403);
    const ok = await setDomain(siteId, '');
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ id: siteId, meshDomainId: '' });
    expect((await setDomain(otherSiteId, '')).status).toBe(409);
    const d = await device();
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: true });
    expect((await bind(d, 'node-A')).status).toBe(200);
    // Bog'langan qurilmasi bor site domain'ini almashtirib bo'lmaydi.
    expect((await setDomain(siteId, 'other')).status).toBe(409);
    const [row] = await app.db.db.select().from(sites).where(eq(sites.id, siteId));
    expect(row?.meshDomainId).toBe('');
  });

  test('admin binds a device to a verified node', async () => {
    await setDomain(siteId, '');
    const d = await device();
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: true });
    mesh.nodes.set('node-X', { domain: 'elsewhere', name: 'pc-x', online: true });
    const nodes = await app.request('GET', `/api/v1/sites/${siteId}/mesh-nodes`, { cookie: admin });
    expect(nodes.status).toBe(200);
    expect(nodes.json.nodes).toEqual([
      {
        meshNodeId: 'node-A',
        name: 'pc-a',
        hostname: 'pc-a.lan',
        osDescription: 'Linux',
        agentOnline: true,
        boundDeviceId: null,
      },
    ]);
    const res = await bind(d, 'node-A');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: d, agent: 'online' });
    const after = await app.request('GET', `/api/v1/sites/${siteId}/mesh-nodes`, { cookie: admin });
    expect(after.json.nodes[0].boundDeviceId).toBe(d);
    expect((await bind(d, 'node-A')).status).toBe(200);
    expect((await bind(d, 'node-B')).status).toBe(409);
    const bound = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'device.bind'));
    expect(bound.map((a) => a.details)).toEqual([{ meshNodeId: 'node-A' }]);
    expect((await app.request('DELETE', `/api/v1/devices/${d}/mesh-binding`, { cookie: admin })).status).toBe(204);
    expect(await app.db.db.select().from(meshBindings)).toHaveLength(0);
    const unbound = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'device.unbind'));
    expect(unbound).toHaveLength(1);
  });

  test('a mesh node binds to at most one device', async () => {
    await setDomain(siteId, '');
    const [d1, d2] = [await device(), await device()];
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: true });
    const results = await Promise.all([bind(d1, 'node-A'), bind(d2, 'node-A')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await app.db.db.select().from(meshBindings)).toHaveLength(1);
  });

  test('binding an unknown node is a conflict', async () => {
    await setDomain(siteId, '');
    const d = await device();
    mesh.nodes.set('node-X', { domain: 'elsewhere', name: 'pc-x', online: true });
    for (const node of ['nope', 'node-X']) {
      const res = await bind(d, node);
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('conflict');
    }
    expect(await app.db.db.select().from(meshBindings)).toHaveLength(0);
  });

  test("site admin cannot bind another site's device", async () => {
    await setDomain(otherSiteId, '');
    await seedUser(app.db.db, orgId, 'siteadmin', [{ role: 'school_admin', siteId }]);
    const siteAdmin = await loginAs(app, 'siteadmin');
    const foreign = await device(otherSiteId, null);
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: true });
    expect((await bind(foreign, 'node-A', siteAdmin)).status).toBe(403);
    const nodes = await app.request('GET', `/api/v1/sites/${otherSiteId}/mesh-nodes`, { cookie: siteAdmin });
    expect(nodes.status).toBe(403);
  });

  test('MeshCentral outage returns upstream_unavailable', async () => {
    await setDomain(siteId, '');
    const d = await device();
    mesh.failing = true;
    const res = await bind(d, 'node-A');
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('upstream_unavailable');
    expect((await app.request('GET', `/api/v1/sites/${siteId}/mesh-nodes`, { cookie: admin })).status).toBe(503);
  });

  test('device list survives MeshCentral outage', async () => {
    await setDomain(siteId, '');
    const d = await device();
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: true });
    await bind(d, 'node-A');
    mesh.failing = true;
    const list = await app.request('GET', `/api/v1/rooms/${roomId}/devices`, { cookie: admin });
    expect(list.status).toBe(200);
    expect(list.json.devices).toMatchObject([{ id: d, agent: 'unknown' }]);
  });

  test('agent state follows mesh snapshot', async () => {
    await setDomain(siteId, '');
    const d = await device();
    const loose = await device();
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: true });
    await bind(d, 'node-A');
    const agentOf = async (id: string) => (await roomDevices()).find((x) => x.id === id)?.agent;
    expect(await agentOf(d)).toBe('online');
    expect(await agentOf(loose)).toBe('unbound');
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: false });
    expect(await agentOf(d)).toBe('offline');
    mesh.nodes.delete('node-A');
    expect(await agentOf(d)).toBe('offline');
  });

  test('retiring a device while it is being bound leaves no binding', async () => {
    await setDomain(siteId, '');
    const d = await device();
    mesh.nodes.set('node-A', { domain: '', name: 'pc-a', online: true });
    const held = mesh.hold();
    const binding = bind(d, 'node-A');
    await held.reached;
    expect((await app.request('DELETE', `/api/v1/devices/${d}`, { cookie: admin })).status).toBe(204);
    held.release();
    expect((await binding).status).toBe(409);
    expect(await app.db.db.select().from(meshBindings)).toHaveLength(0);
    const [row] = await app.db.db.select().from(devices).where(eq(devices.id, d));
    expect(row?.retiredAt).not.toBeNull();
  });

  test('changing the site domain while a device is being bound keeps them consistent', async () => {
    await setDomain(siteId, 'dom-a');
    const d = await device();
    mesh.nodes.set('node-A', { domain: 'dom-a', name: 'pc-a', online: true });
    const held = mesh.hold();
    const binding = bind(d, 'node-A');
    await held.reached;
    expect((await setDomain(siteId, 'dom-b')).status).toBe(200);
    held.release();
    expect((await binding).status).toBe(409);
    expect(await app.db.db.select().from(meshBindings)).toHaveLength(0);
  });

  test('database refuses a binding whose domain differs from its site', async () => {
    await setDomain(siteId, 'dom-a');
    const d = await device();
    const [row] = await app.db.db.select().from(devices).where(eq(devices.id, d));
    if (!row) throw new Error('device');
    const insert = (meshDomainId: string) =>
      app.db.db.insert(meshBindings).values({
        deviceId: d,
        organizationId: orgId,
        siteId,
        meshInstanceId: 'local',
        meshDomainId,
        meshNodeId: 'node-A',
        boundBy: d,
      });
    await expect(insert('dom-b')).rejects.toThrow();
    await insert('dom-a');
    // Bog'langan site domain'ini DB ham o'zgartirtirmaydi.
    await expect(app.db.db.update(sites).set({ meshDomainId: 'dom-c' }).where(eq(sites.id, siteId))).rejects.toThrow();
  });
});
