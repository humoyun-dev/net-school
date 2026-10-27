import type { DeviceEvent, UpstreamDeviceRef } from '@netschool/domain';
import {
  AdapterError,
  MeshCentralDeviceManagement,
  MeshCentralPrincipals,
  MeshControlClient,
  type MeshControlClientOptions,
  type SiteMeshScope,
} from '@netschool/meshcentral-adapter';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeCert } from '../../packages/meshcentral-adapter/test/support/fake-mesh-server.ts';
import { type MeshCentralInstance, startMeshCentral } from './harness/meshcentral.ts';

const scope: SiteMeshScope = { meshInstanceId: 'mc-test', meshDomainId: '' };
const site = new Map([['site-a', scope]]);

let mc: MeshCentralInstance;
let admin: MeshControlClient;
let meshid: string;
const clients: MeshControlClient[] = [];

function client(overrides: Partial<MeshControlClientOptions> = {}) {
  const c = new MeshControlClient({
    url: mc.url,
    ca: mc.ca,
    username: mc.admin.username,
    password: mc.admin.password,
    reconnect: { minDelayMs: 100, maxDelayMs: 1_000 },
    ...overrides,
  });
  clients.push(c);
  return c;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof AdapterError ? err.code : `not-adapter-error: ${String(err)}`;
  }
  return 'resolved';
}

async function addLocalDevice(name: string) {
  await admin.request('addlocaldevice', { meshid, devicename: name, hostname: `${name}.lan`, type: 4 });
}

async function deviceNamed(name: string): Promise<UpstreamDeviceRef> {
  const found = (await new MeshCentralDeviceManagement(admin, site).listDevices('site-a')).find((d) => d.name === name);
  if (!found) throw new Error(`${name} not found`);
  return found.upstream;
}

beforeAll(async () => {
  mc = await startMeshCentral();
  admin = client();
  await admin.connect();
  meshid = (await admin.request<{ meshid: string }>('createmesh', { meshname: 'contract', meshtype: 3 })).meshid;
  await addLocalDevice('pc-01');
  await addLocalDevice('pc-02');
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await mc?.stop();
});

describe('MeshCentral adapter against pinned upstream', () => {
  test('connects with valid credentials and the instance CA', async () => {
    await expect(client().connect()).resolves.toBeUndefined();
  });

  test('rejects wrong password with upstream_auth_failed', async () => {
    expect(await codeOf(client({ password: 'wrong-password' }).connect())).toBe('upstream_auth_failed');
  });

  test('rejects a foreign CA with upstream_tls_failed', async () => {
    const foreign = await makeCert();
    expect(await codeOf(client({ ca: foreign.cert }).connect())).toBe('upstream_tls_failed');
  });

  test('lists both local devices as offline', async () => {
    const devices = await new MeshCentralDeviceManagement(admin, site).listDevices('site-a');
    expect(devices.map((d) => d.name).sort()).toEqual(['pc-01', 'pc-02']);
    expect(devices.every((d) => d.agentOnline === false)).toBe(true);
  });

  test('emits device.added when a device is added', async () => {
    const events: DeviceEvent[] = [];
    const off = new MeshCentralDeviceManagement(admin, site).subscribeDeviceEvents((e) => events.push(e));
    try {
      await addLocalDevice('pc-03');
      await expect.poll(() => events.some((e) => e.type === 'device.added'), { timeout: 10_000 }).toBe(true);
    } finally {
      off();
      await admin.request('removedevices', { nodeids: [`node//${(await deviceNamed('pc-03')).meshNodeId}`] });
    }
  });

  test('principal is created under strict password requirements', async () => {
    const principal = await new MeshCentralPrincipals(admin).create(await deviceNamed('pc-01'), 'view');
    await expect(
      client({ username: principal.username, password: principal.password }).connect(),
    ).resolves.toBeUndefined();
  });

  test('principal sees only the granted node', async () => {
    const principal = await new MeshCentralPrincipals(admin).create(await deviceNamed('pc-01'), 'view');
    const asPrincipal = client({ username: principal.username, password: principal.password });
    await asPrincipal.connect();
    const visible = await new MeshCentralDeviceManagement(asPrincipal, site).listDevices('site-a');
    expect(visible.map((d) => d.name)).toEqual(['pc-01']);
  });

  test('principal has no site rights', async () => {
    const principal = await new MeshCentralPrincipals(admin).create(await deviceNamed('pc-02'), 'control');
    const asPrincipal = client({ username: principal.username, password: principal.password });
    await asPrincipal.connect();
    const err = await asPrincipal
      .request('adduser', { username: 'escalate', pass: 'Escalate-123!', siteadmin: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('upstream_rejected');
    expect((err as AdapterError).detail).toBe('Permission denied');
  });

  test('principal cannot create device groups', async () => {
    const principal = await new MeshCentralPrincipals(admin).create(await deviceNamed('pc-01'), 'view');
    const asPrincipal = client({ username: principal.username, password: principal.password });
    await asPrincipal.connect();
    const err = await asPrincipal.request('createmesh', { meshname: 'escape', meshtype: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).detail).toBe('Permission denied');
  });

  test('revoked principal can no longer authenticate', async () => {
    const principals = new MeshCentralPrincipals(admin);
    const principal = await principals.create(await deviceNamed('pc-01'), 'view');
    await client({ username: principal.username, password: principal.password }).connect();
    await principals.revoke(principal.userId);
    expect(await codeOf(client({ username: principal.username, password: principal.password }).connect())).toBe(
      'upstream_auth_failed',
    );
  });

  test('adapter resyncs after MeshCentral restart', async () => {
    let resyncs = 0;
    const off = new MeshCentralDeviceManagement(admin, site).subscribeDeviceEvents((e) => {
      if (e.type === 'resync') resyncs++;
    });
    try {
      await mc.restart();
      await expect.poll(() => resyncs, { timeout: 30_000, interval: 200 }).toBe(1);
      const devices = await new MeshCentralDeviceManagement(admin, site).listDevices('site-a');
      expect(devices.map((d) => d.name).sort()).toEqual(['pc-01', 'pc-02']);
    } finally {
      off();
    }
  });
});
