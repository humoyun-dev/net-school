import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, deviceCapabilities, devices } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { type DeviceKey, deviceRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { seedOrg } from './support/seed.ts';

let now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let key: DeviceKey;
let deviceId: string;

const report = {
  protocolVersion: 1,
  os: 'macos',
  architecture: 'arm64',
  desktopSession: 'macos',
  capabilities: {
    'screen.view': { state: 'requires_permission', provider: 'screen_recording' },
    'classroom.overlay': { state: 'available', enforcement: 'soft' },
  },
};

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  await app.db.reset();
  let siteId: string;
  ({ orgId, siteId } = await seedOrg(app.db.db));
  key = makeDeviceKey();
  deviceId = await seedDevice(app.db.db, orgId, siteId, key.publicKey);
});
afterAll(async () => {
  await app?.close();
});

const send = (method: string, path: string, body: unknown) => {
  now += 1; // har so'rov yangi timestamp bilan
  return deviceRequest(app, key, deviceId, method, path, body, now);
};
const changes = () => app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'device.capabilities_changed'));

describe('device presence', () => {
  test('heartbeat updates last seen', async () => {
    const res = await send('POST', '/api/v1/device/heartbeat', {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ heartbeatIntervalSeconds: 10 });
    const [row] = await app.db.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row?.lastHeartbeatAt?.getTime()).toBe(now);
    expect((await send('POST', '/api/v1/device/heartbeat', { extra: 1 })).status).toBe(400);
  });

  test('capability change is stored and audited once', async () => {
    expect((await send('PUT', '/api/v1/device/capabilities', report)).status).toBe(204);
    const granted = {
      ...report,
      capabilities: { ...report.capabilities, 'screen.view': { state: 'available', provider: 'screen_recording' } },
    };
    expect((await send('PUT', '/api/v1/device/capabilities', granted)).status).toBe(204);
    const [row] = await app.db.db.select().from(deviceCapabilities);
    expect(row?.report).toEqual(granted);
    expect(row?.reportedAt.getTime()).toBe(now);
    const audits = await changes();
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => (a.details as { changed: string[] }).changed)).toContainEqual(['screen.view']);
    expect(audits.every((a) => a.organizationId === orgId && a.targetId === deviceId && a.actorUserId === null)).toBe(
      true,
    );
  });

  test('identical capability report is not audited', async () => {
    // jsonb kalit tartibini o'zgartiradi; taqqoslash tartibga bog'liq bo'lmasligi kerak.
    await app.db.db.insert(deviceCapabilities).values({
      deviceId,
      organizationId: orgId,
      report: { ...report, capabilities: Object.fromEntries(Object.entries(report.capabilities).reverse()) },
      reportedAt: new Date(now - 60_000),
    });
    expect((await send('PUT', '/api/v1/device/capabilities', report)).status).toBe(204);
    expect(await changes()).toHaveLength(0);
    const [row] = await app.db.db.select().from(deviceCapabilities);
    expect(row?.reportedAt.getTime()).toBe(now);
  });

  test('invalid capability report is 400 and changes nothing', async () => {
    const bad = { ...report, capabilities: { 'screen.view': { state: 'maybe' } } };
    const res = await send('PUT', '/api/v1/device/capabilities', bad);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation_failed');
    expect(await app.db.db.select().from(deviceCapabilities)).toHaveLength(0);
    expect(await changes()).toHaveLength(0);
  });
});
