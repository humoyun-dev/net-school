import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// Real API + PGlite: to'liq suite yuklamasida hook'lar sekinlashadi.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

import { ThumbnailStore } from '../../../apps/api/src/modules/thumbnails/thumbnail-store.ts';
import { startTestApp, type TestApp } from '../../../apps/api/test/support/app.ts';
import { setCapabilities } from '../../../apps/api/test/support/caps.ts';
import { deviceRequest, makeDeviceKey, seedDevice } from '../../../apps/api/test/support/device.ts';
import { FakeMesh } from '../../../apps/api/test/support/mesh.ts';
import { setSiteDomain } from '../../../apps/api/test/support/power.ts';
import { FakeRemote } from '../../../apps/api/test/support/remote.ts';
import { PASSWORD, seedOrg, seedUser } from '../../../apps/api/test/support/seed.ts';
import { connectHub } from '../hub-client.mjs';
import { hubctl } from '../hubctl.mjs';
import { verify } from '../verify.mjs';

const mesh = new FakeMesh();
const remote = new FakeRemote();
let app: TestApp;
let siteName: string;
let orgId: string;
let siteId: string;
let stopDevice: () => void = () => {};

beforeAll(async () => {
  app = await startTestApp({ deviceManagement: mesh.factory, remote: remote.upstream, mesh: { connected: true } });
});
beforeEach(async () => {
  stopDevice();
  mesh.nodes.clear();
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  siteName = 'Maktab 1 bino A';
  await setSiteDomain(app.db.db, siteId, '');
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
});
afterAll(async () => {
  stopDevice();
  await app?.close();
});

const hub = () => connectHub({ origin: app.origin, ca: app.ca, username: 'admin1', password: PASSWORD });

// Companion o'rnida: heartbeat, buyruqlarni olib `succeeded` receipt, miniatura kadri.
async function enrollSimulatedDevice(roomId: string) {
  const key = makeDeviceKey();
  const id = await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId, hostname: 'WIN-PC-01' });
  await setCapabilities(app.db.db, orgId, id, {
    'classroom.message': { state: 'available' },
    'classroom.overlay': { state: 'available' },
    'classroom.help': { state: 'available' },
    'classroom.thumbnails': { state: 'available' },
  });
  let running = true;
  const loop = async () => {
    while (running) {
      const hb = await deviceRequest(app, key, id, 'POST', '/api/v1/device/heartbeat', {});
      const lessonId = hb.json?.lesson?.id as string | undefined;
      if (lessonId) app.get<ThumbnailStore>(ThumbnailStore).put(id, lessonId, Buffer.from([0xff, 0xd8, 0xff, 1]));
      const res = await deviceRequest(app, key, id, 'GET', '/api/v1/device/commands?wait=0');
      for (const c of (res.json?.commands ?? []) as { commandId: string }[]) {
        const path = `/api/v1/device/commands/${c.commandId}/receipt`;
        await deviceRequest(app, key, id, 'POST', path, { status: 'acknowledged' });
        await deviceRequest(app, key, id, 'POST', path, { status: 'succeeded' });
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  void loop();
  stopDevice = () => {
    running = false;
  };
  return id;
}

describe('PoC hub control and verification', () => {
  test('hubctl creates a room, an enrollment token and binds a node', async () => {
    const c = await hub();
    const out: string[] = [];
    const print = (s: string) => out.push(s);
    await hubctl(c, ['room', 'create', 'Lab-1', '--site', siteName], print);
    await hubctl(c, ['enrollment', 'create', '--room', 'Lab-1'], print);
    expect(out.join('\n')).toMatch(/token: nse_/);
    const roomId = (await c.get(`/api/v1/sites/${siteId}/rooms`)).rooms[0].id;
    await enrollSimulatedDevice(roomId);
    mesh.nodes.set('node-win', { domain: '', name: 'WIN-PC-01', online: true });
    await hubctl(c, ['mesh', 'nodes', '--site', siteName], print);
    expect(out.join('\n')).toContain('node-win');
    await hubctl(c, ['mesh', 'bind', 'WIN-PC-01', 'node-win'], print);
    const devices = (await c.get(`/api/v1/rooms/${roomId}/devices`)).devices;
    expect(devices[0]).toMatchObject({ hostname: 'WIN-PC-01', agent: 'online' });
  });

  test('verify passes on a healthy simulated device and writes evidence', async () => {
    const c = await hub();
    await hubctl(c, ['room', 'create', 'Lab-1', '--site', siteName], () => {});
    const roomId = (await c.get(`/api/v1/sites/${siteId}/rooms`)).rooms[0].id;
    await enrollSimulatedDevice(roomId);
    mesh.nodes.set('node-win', { domain: '', name: 'WIN-PC-01', online: true });
    await hubctl(c, ['mesh', 'bind', 'WIN-PC-01', 'node-win'], () => {});
    const report = await verify(c, { room: 'Lab-1', timeoutMs: 10_000 });
    const byId = Object.fromEntries(report.steps.map((s: { id: string; status: string }) => [s.id, s.status]));
    expect(byId).toEqual({
      device_found: 'passed',
      device_enrolled: 'passed',
      capabilities: 'passed',
      agent_bound: 'passed',
      message: 'passed',
      overlay: 'passed',
      thumbnail: 'passed',
      remote: 'passed',
    });
    expect(report.device).toMatchObject({ hostname: 'WIN-PC-01' });
    expect(report.steps.every((s: { evidence: unknown }) => s.evidence !== undefined)).toBe(true);
  });

  test('verify reports an offline agent with the alias it should reach', async () => {
    const c = await hub();
    await hubctl(c, ['room', 'create', 'Lab-1', '--site', siteName], () => {});
    const roomId = (await c.get(`/api/v1/sites/${siteId}/rooms`)).rooms[0].id;
    await enrollSimulatedDevice(roomId);
    mesh.nodes.set('node-win', { domain: '', name: 'WIN-PC-01', online: false });
    await hubctl(c, ['mesh', 'bind', 'WIN-PC-01', 'node-win'], () => {});
    const report = await verify(c, { room: 'Lab-1', timeoutMs: 5_000, agentHost: 'hub.school.lan:4433' });
    const agent = report.steps.find((s: { id: string }) => s.id === 'agent_bound');
    expect(agent.status).toBe('failed');
    expect(agent.error).toContain('hub.school.lan:4433');
    expect(agent.error).toContain('Test-NetConnection');
  });

  test('a failed step does not stop later independent steps', async () => {
    const c = await hub();
    await hubctl(c, ['room', 'create', 'Lab-1', '--site', siteName], () => {});
    const roomId = (await c.get(`/api/v1/sites/${siteId}/rooms`)).rooms[0].id;
    await enrollSimulatedDevice(roomId);
    // Bog'lanmagan: agent va remote yiqiladi, Companion qadamlari baribir tekshiriladi.
    const report = await verify(c, { room: 'Lab-1', timeoutMs: 10_000 });
    const byId = Object.fromEntries(report.steps.map((s: { id: string; status: string }) => [s.id, s.status]));
    expect(byId.agent_bound).toBe('failed');
    expect(byId.remote).toBe('failed');
    expect(byId.message).toBe('passed');
    expect(byId.overlay).toBe('passed');
  });
});
