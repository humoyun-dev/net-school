import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, devices } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { type DeviceKey, deviceRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let siteId: string;
let otherSiteId: string;
let roomId: string;
let otherRoomId: string;

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  await app.db.reset();
  ({ orgId, siteId, otherSiteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
});
afterAll(async () => {
  await app?.close();
});

async function device(site: string, room?: string, hostname = 'pc') {
  const key = makeDeviceKey();
  const id = await seedDevice(app.db.db, orgId, site, key.publicKey, { roomId: room, hostname });
  return { id, key };
}
const heartbeat = (d: { id: string; key: DeviceKey }) => {
  now += 1;
  return deviceRequest(app, d.key, d.id, 'POST', '/api/v1/device/heartbeat', {}, now);
};
const denials = () =>
  app.db.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.result, 'denied')));

describe('devices', () => {
  test('teacher lists devices in assigned room with presence', async () => {
    await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    const teacher = await loginAs(app, 'teacher1');
    const live = await device(siteId, roomId, 'pc-live');
    await device(siteId, roomId, 'pc-new');
    const retired = await device(siteId, roomId, 'pc-old');
    await app.db.db
      .update(devices)
      .set({ retiredAt: new Date(now) })
      .where(eq(devices.id, retired.id));
    await device(siteId, otherRoomId, 'pc-elsewhere');
    expect((await heartbeat(live)).status).toBe(200);

    const res = await app.request('GET', `/api/v1/rooms/${roomId}/devices`, { cookie: teacher });
    expect(res.status).toBe(200);
    const byHost = Object.fromEntries(res.json.devices.map((d: { hostname: string }) => [d.hostname, d]));
    expect(Object.keys(byHost).sort()).toEqual(['pc-live', 'pc-new']);
    expect(byHost['pc-live']).toMatchObject({
      id: live.id,
      siteId,
      roomId,
      companion: { presence: 'online', lastHeartbeatAt: new Date(now).toISOString() },
      agent: 'unbound',
      capabilities: null,
    });
    expect(byHost['pc-new'].companion).toEqual({ presence: 'never', lastHeartbeatAt: null });

    now += 30_000;
    const later = await app.request('GET', `/api/v1/rooms/${roomId}/devices`, { cookie: teacher });
    const liveLater = later.json.devices.find((d: { id: string }) => d.id === live.id);
    expect(liveLater.companion.presence).toBe('stale');
  });

  test('teacher cannot list site devices or other rooms', async () => {
    await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    const teacher = await loginAs(app, 'teacher1');
    expect((await app.request('GET', `/api/v1/sites/${siteId}/devices`, { cookie: teacher })).status).toBe(403);
    expect((await app.request('GET', `/api/v1/rooms/${otherRoomId}/devices`, { cookie: teacher })).status).toBe(403);
    expect((await app.request('GET', '/api/v1/rooms/not-a-uuid/devices', { cookie: teacher })).status).toBe(403);
  });

  test("site admin cannot touch another site's devices", async () => {
    await seedUser(app.db.db, orgId, 'siteadmin', [{ role: 'school_admin', siteId }]);
    const admin = await loginAs(app, 'siteadmin');
    const foreign = await device(otherSiteId);
    const before = (await denials()).length;
    expect((await app.request('GET', `/api/v1/sites/${otherSiteId}/devices`, { cookie: admin })).status).toBe(403);
    const put = await app.request('PUT', `/api/v1/devices/${foreign.id}/room`, { body: { roomId }, cookie: admin });
    expect(put.status).toBe(403);
    expect((await app.request('DELETE', `/api/v1/devices/${foreign.id}`, { cookie: admin })).status).toBe(403);
    expect((await denials()).length - before).toBe(3);
    const [row] = await app.db.db.select().from(devices).where(eq(devices.id, foreign.id));
    expect(row).toMatchObject({ roomId: null, retiredAt: null });
    const own = await app.request('GET', `/api/v1/sites/${siteId}/devices`, { cookie: admin });
    expect(own.status).toBe(200);
  });

  test('assigning a room from another site is denied and audited', async () => {
    await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
    const admin = await loginAs(app, 'admin1');
    const d = await device(siteId);
    const farRoom = await seedRoom(app.db.db, orgId, otherSiteId, '201');
    const denied = await app.request('PUT', `/api/v1/devices/${d.id}/room`, {
      body: { roomId: farRoom },
      cookie: admin,
    });
    expect(denied.status).toBe(403);
    expect((await denials()).map((a) => [a.action, a.targetType, a.targetId])).toEqual([
      ['device.manage', 'room', farRoom],
    ]);
    const ok = await app.request('PUT', `/api/v1/devices/${d.id}/room`, { body: { roomId }, cookie: admin });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id: d.id, roomId });
    const cleared = await app.request('PUT', `/api/v1/devices/${d.id}/room`, { body: { roomId: null }, cookie: admin });
    expect(cleared.json.roomId).toBeNull();
    const assigned = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'device.assign_room'));
    expect(assigned).toHaveLength(2);
  });

  test('retired device disappears and cannot heartbeat', async () => {
    await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
    const admin = await loginAs(app, 'admin1');
    const d = await device(siteId, roomId);
    expect((await heartbeat(d)).status).toBe(200);
    expect((await app.request('DELETE', `/api/v1/devices/${d.id}`, { cookie: admin })).status).toBe(204);
    const list = await app.request('GET', `/api/v1/rooms/${roomId}/devices`, { cookie: admin });
    expect(list.json.devices).toEqual([]);
    expect((await heartbeat(d)).status).toBe(401);
    const retired = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'device.retire'));
    expect(retired).toHaveLength(1);
  });
});
