import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  auditEvents,
  commands,
  commandTargets,
  devices,
  events,
  lessonDevices,
  lessons,
  outbox,
} from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, idem, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let siteId: string;
let roomId: string;
let otherRoomId: string;
let teacher: string;
let teacherId: string;

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  teacherId = await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  teacher = await loginAs(app, 'teacher1');
});
afterAll(async () => {
  await app?.close();
});

const device = (room: string | undefined = roomId) =>
  seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId: room });

describe('lessons', () => {
  test('teacher starts a lesson in an assigned room', async () => {
    const live = await device();
    const retired = await device();
    await app.db.db
      .update(devices)
      .set({ retiredAt: new Date(now) })
      .where(eq(devices.id, retired));
    await device(otherRoomId);
    const res = await startLesson(app, teacher, roomId, { title: 'Informatika' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      siteId,
      roomId,
      teacherUserId: teacherId,
      title: 'Informatika',
      status: 'active',
      startedAt: new Date(now).toISOString(),
      scheduledEndAt: new Date(now + 90 * 60_000).toISOString(),
      endedAt: null,
      endReason: null,
      deviceIds: [live],
    });
    const active = await app.request('GET', `/api/v1/rooms/${roomId}/lessons/active`, { cookie: teacher });
    expect(active.json.lesson.id).toBe(res.json.id);
    const empty = await app.request('GET', `/api/v1/rooms/${otherRoomId}/lessons/active`, { cookie: teacher });
    expect(empty.status).toBe(403);
    const got = await app.request('GET', `/api/v1/lessons/${res.json.id}`, { cookie: teacher });
    expect(got.json).toEqual(res.json);
  });

  test('teacher cannot start in another room', async () => {
    const res = await startLesson(app, teacher, otherRoomId);
    expect(res.status).toBe(403);
    const denied = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'lesson.start'), eq(auditEvents.result, 'denied')));
    expect(denied).toHaveLength(1);
    expect(await app.db.db.select().from(lessons)).toHaveLength(0);
  });

  test('one active lesson per room under concurrency', async () => {
    await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    const teacher2 = await loginAs(app, 'teacher2');
    const results = await Promise.all([startLesson(app, teacher, roomId), startLesson(app, teacher2, roomId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.json.error.code).toBe('conflict');
    expect(await app.db.db.select().from(lessons)).toHaveLength(1);
  });

  test('only the owner or an admin ends a lesson', async () => {
    await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    const teacher2 = await loginAs(app, 'teacher2');
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const denied = await endLesson(app, teacher2, lesson.id);
    expect(denied.status).toBe(403);
    const ended = await endLesson(app, teacher, lesson.id);
    expect(ended.status).toBe(200);
    expect(ended.json).toMatchObject({ status: 'ended', endReason: 'teacher', endedAt: new Date(now).toISOString() });
    expect((await endLesson(app, teacher, lesson.id)).status).toBe(409);

    await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
    const admin = await loginAs(app, 'admin1');
    const second = (await startLesson(app, teacher, roomId)).json;
    const byAdmin = await endLesson(app, admin, second.id);
    expect(byAdmin.json.endReason).toBe('admin');
  });

  test('ending a lesson cancels open targets', async () => {
    const d1 = await device();
    const d2 = await device();
    const d3 = await device();
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const [cmd] = await app.db.db
      .insert(commands)
      .values({
        organizationId: orgId,
        siteId,
        lessonId: lesson.id,
        issuedBy: teacherId,
        type: 'overlay.lock',
        payload: {},
        issuedAt: new Date(now),
        expiresAt: new Date(now + 60_000),
      })
      .returning();
    if (!cmd) throw new Error('cmd');
    const at = new Date(now);
    await app.db.db.insert(commandTargets).values([
      { commandId: cmd.id, deviceId: d1, organizationId: orgId, status: 'pending', updatedAt: at },
      { commandId: cmd.id, deviceId: d2, organizationId: orgId, status: 'sent', updatedAt: at },
      { commandId: cmd.id, deviceId: d3, organizationId: orgId, status: 'succeeded', updatedAt: at },
    ]);
    now += 1_000;
    expect((await endLesson(app, teacher, lesson.id)).status).toBe(200);
    const targets = await app.db.db.select().from(commandTargets);
    const byDevice = Object.fromEntries(targets.map((t) => [t.deviceId, t]));
    expect(byDevice[d1]?.status).toBe('cancelled');
    expect(byDevice[d2]?.status).toBe('cancelled');
    expect(byDevice[d3]?.status).toBe('succeeded');
    expect(byDevice[d1]?.finishedAt?.getTime()).toBe(now);
    const joined = await app.db.db.select().from(lessonDevices);
    expect(joined.every((j) => j.releasedAt?.getTime() === now)).toBe(true);
  });

  test('start and end are idempotent with the same key', async () => {
    const key = idem();
    const a = await startLesson(app, teacher, roomId, { title: 'A' }, key);
    const b = await startLesson(app, teacher, roomId, { title: 'A' }, key);
    expect(b.status).toBe(201);
    expect(b.json).toEqual(a.json);
    expect(await app.db.db.select().from(lessons)).toHaveLength(1);
    const endKey = idem();
    expect((await endLesson(app, teacher, a.json.id, endKey)).status).toBe(200);
    const replay = await endLesson(app, teacher, a.json.id, endKey);
    expect(replay.status).toBe(200);
    expect(replay.json.status).toBe('ended');
  });

  test('lesson start and end append events and audit', async () => {
    const d = await device();
    const lesson = (await startLesson(app, teacher, roomId)).json;
    await endLesson(app, teacher, lesson.id);
    const log = await app.db.db.select().from(events).orderBy(events.seq);
    expect(log.map((e) => [e.type, e.roomId, e.lessonId])).toEqual([
      ['lesson.started', roomId, lesson.id],
      ['lesson.ended', roomId, lesson.id],
    ]);
    const queued = await app.db.db.select().from(outbox).orderBy(outbox.id);
    expect(queued.map((o) => o.topic)).toEqual(['notify.rooms', 'notify.devices', 'notify.rooms', 'notify.devices']);
    expect(queued[1]?.payload).toEqual({ deviceIds: [d] });
    const audit = await app.db.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.result, 'succeeded'))
      .orderBy(auditEvents.at);
    expect(audit.map((a) => a.action).filter((a) => a.startsWith('lesson.'))).toEqual(['lesson.start', 'lesson.end']);
  });
});
