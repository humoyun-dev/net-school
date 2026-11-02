import { helpRequestSchema } from '@netschool/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, events, helpRequests } from '../src/db/schema.ts';
import { MaintenanceWorker } from '../src/modules/workers/maintenance.worker.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { type DeviceKey, deviceRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let siteId: string;
let roomId: string;
let otherRoomId: string;
let teacher: string;
let teacher2: string;
let admin: string;
let a: { id: string; key: DeviceKey };
let b: { id: string; key: DeviceKey };

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [otherRoomId] });
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  teacher = await loginAs(app, 'teacher1');
  teacher2 = await loginAs(app, 'teacher2');
  admin = await loginAs(app, 'admin1');
  const mk = async () => {
    const key = makeDeviceKey();
    return { id: await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId }), key };
  };
  a = await mk();
  b = await mk();
});
afterAll(async () => {
  await app?.close();
});

const signed = (d: { id: string; key: DeviceKey }, method: string, path: string, body?: unknown) => {
  now += 1;
  return deviceRequest(app, d.key, d.id, method, path, body, now);
};
const raise = (d = a) => signed(d, 'POST', '/api/v1/device/help-request', {});
const withdraw = (d = a) => signed(d, 'DELETE', '/api/v1/device/help-request');
const beat = (d = a) => signed(d, 'POST', '/api/v1/device/heartbeat', {});
const clear = (cookie: string, id: string) => app.request('DELETE', `/api/v1/help-requests/${id}`, { cookie });
const helpEvents = async (type: 'help_request.raised' | 'help_request.cleared') =>
  (await app.db.db.select().from(events)).filter((e) => e.type === type);
const rows = () => app.db.db.select().from(helpRequests);
const denied = () => app.db.db.select().from(auditEvents).where(eq(auditEvents.result, 'denied'));

describe('help requests', () => {
  test('a lesson device raises help once', async () => {
    const lessonId = (await startLesson(app, teacher, roomId)).json.id;
    const first = await raise();
    expect(first.status).toBe(200);
    expect(helpRequestSchema.parse(first.json)).toMatchObject({
      lessonId,
      deviceId: a.id,
      clearedAt: null,
      clearReason: null,
    });
    const second = await raise();
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);
    expect(await rows()).toHaveLength(1);
    const raised = await helpEvents('help_request.raised');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.data).toEqual({ helpRequestId: first.json.id, deviceId: a.id });
    expect(raised[0]?.roomId).toBe(roomId);
    const hb = await beat();
    expect(hb.json.lesson.helpRequest).toEqual({ id: first.json.id, raisedAt: first.json.raisedAt });
    expect((await beat(b)).json.lesson.helpRequest).toBeNull();
  });

  test('raising help outside an active lesson is a conflict', async () => {
    const none = await raise();
    expect(none.status).toBe(409);
    expect(none.json.error.code).toBe('conflict');
    const lessonId = (await startLesson(app, teacher, roomId)).json.id;
    await endLesson(app, teacher, lessonId);
    expect((await raise()).status).toBe(409);
    expect(await rows()).toHaveLength(0);
    expect(await helpEvents('help_request.raised')).toHaveLength(0);
  });

  test('a device request body must be empty', async () => {
    await startLesson(app, teacher, roomId);
    expect((await signed(a, 'POST', '/api/v1/device/help-request', { text: 'x' })).status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  test('the lesson owner clears help and the device sees it on the next heartbeat', async () => {
    await startLesson(app, teacher, roomId);
    const raised = (await raise()).json;
    expect((await clear(teacher, raised.id)).status).toBe(204);
    expect((await beat()).json.lesson.helpRequest).toBeNull();
    const [row] = await rows();
    expect(row).toMatchObject({ clearReason: 'teacher', clearedBy: expect.any(String) });
    expect(row?.clearedAt?.getTime()).toBe(now - 1);
    const cleared = await helpEvents('help_request.cleared');
    expect(cleared.map((e) => e.data)).toEqual([{ helpRequestId: raised.id, deviceId: a.id, reason: 'teacher' }]);
    // Ikkinchi DELETE no-op: yangi event yo'q.
    expect((await clear(teacher, raised.id)).status).toBe(204);
    expect(await helpEvents('help_request.cleared')).toHaveLength(1);
    // Yopilgandan keyin qo'l qayta ko'tariladi: yangi so'rov.
    const again = (await raise()).json;
    expect(again.id).not.toBe(raised.id);
    expect(await rows()).toHaveLength(2);
  });

  test('a school admin can clear help too', async () => {
    await startLesson(app, teacher, roomId);
    const raised = (await raise()).json;
    expect((await clear(admin, raised.id)).status).toBe(204);
    expect((await rows())[0]?.clearReason).toBe('teacher');
  });

  test('another teacher cannot clear help', async () => {
    await startLesson(app, teacher, roomId);
    const raised = (await raise()).json;
    const res = await clear(teacher2, raised.id);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('scope_denied');
    const unknown = await clear(teacher, '00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(403);
    expect(unknown.json.error.code).toBe('scope_denied');
    expect((await clear(teacher, 'not-a-uuid')).status).toBe(403);
    const audits = await denied();
    expect(audits).toHaveLength(3);
    expect(audits.every((e) => e.action === 'help.clear')).toBe(true);
    expect((await rows())[0]?.clearedAt).toBeNull();
  });

  test('the device withdraws its own help', async () => {
    await startLesson(app, teacher, roomId);
    const raised = (await raise()).json;
    expect((await withdraw()).status).toBe(204);
    expect((await rows())[0]).toMatchObject({ clearReason: 'device', clearedBy: null });
    expect((await helpEvents('help_request.cleared')).map((e) => e.data)).toEqual([
      { helpRequestId: raised.id, deviceId: a.id, reason: 'device' },
    ]);
    expect((await beat()).json.lesson.helpRequest).toBeNull();
    // Ochiq so'rov bo'lmasa no-op.
    expect((await withdraw()).status).toBe(204);
    expect((await withdraw(b)).status).toBe(204);
    expect(await helpEvents('help_request.cleared')).toHaveLength(1);
  });

  test('ending the lesson clears open help', async () => {
    const first = (await startLesson(app, teacher, roomId)).json.id;
    await raise(a);
    await raise(b);
    expect((await endLesson(app, teacher, first)).status).toBe(200);
    const closed = await rows();
    expect(closed).toHaveLength(2);
    expect(closed.every((r) => r.clearReason === 'lesson_ended' && r.clearedAt !== null)).toBe(true);
    expect(closed.every((r) => r.clearedBy !== null)).toBe(true);
    expect(await helpEvents('help_request.cleared')).toHaveLength(2);

    // Maintenance timeout: egasiz yopiladi.
    await app.db.reset();
    ({ orgId, siteId } = await seedOrg(app.db.db));
    roomId = await seedRoom(app.db.db, orgId, siteId, '101');
    await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    teacher = await loginAs(app, 'teacher1');
    const key = makeDeviceKey();
    const c = { id: await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId }), key };
    await startLesson(app, teacher, roomId, { durationMinutes: 5 });
    await raise(c);
    now += 5 * 60_000;
    expect((await app.get<MaintenanceWorker>(MaintenanceWorker).tick(now)).endedLessons).toBe(1);
    const [row] = await rows();
    expect(row).toMatchObject({ clearReason: 'lesson_ended', clearedBy: null });
    expect((await helpEvents('help_request.cleared')).map((e) => (e.data as { reason: string }).reason)).toEqual([
      'lesson_ended',
    ]);
  });

  test('a device leaving the lesson clears its help', async () => {
    await startLesson(app, teacher, roomId);
    await raise(a);
    const kept = (await raise(b)).json;
    const moved = await app.request('PUT', `/api/v1/devices/${a.id}/room`, {
      body: { roomId: otherRoomId },
      cookie: admin,
    });
    expect(moved.status).toBe(200);
    const all = await rows();
    expect(all.find((r) => r.deviceId === a.id)).toMatchObject({ clearReason: 'device_left' });
    expect(all.find((r) => r.deviceId === b.id)?.clearedAt).toBeNull();
    const cleared = await helpEvents('help_request.cleared');
    expect(cleared.map((e) => [e.roomId, (e.data as { reason: string }).reason])).toEqual([[roomId, 'device_left']]);
    expect((await beat(b)).json.lesson.helpRequest.id).toBe(kept.id);
  });

  test('retiring a device clears its help', async () => {
    await startLesson(app, teacher, roomId);
    await raise(a);
    expect((await app.request('DELETE', `/api/v1/devices/${a.id}`, { cookie: admin })).status).toBe(204);
    expect((await rows())[0]?.clearReason).toBe('device_left');
  });

  test('snapshot lists open help requests', async () => {
    const lessonId = (await startLesson(app, teacher, roomId)).json.id;
    const first = (await raise(a)).json;
    const second = (await raise(b)).json;
    await clear(teacher, second.id);
    const snap = await app.request('GET', `/api/v1/events?roomId=${roomId}`, { cookie: teacher });
    expect(snap.json.snapshot.helpRequests).toEqual([
      { id: first.id, lessonId, deviceId: a.id, raisedAt: first.raisedAt, clearedAt: null, clearReason: null },
    ]);
    // Help audit qilinmaydi (receipt'lar kabi): faqat events.
    expect(
      await app.db.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.targetType, 'help_request'))),
    ).toEqual([]);
  });
});
