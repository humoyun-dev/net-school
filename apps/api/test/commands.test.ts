import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, commands, events, lessonDevices, outbox } from '../src/db/schema.ts';
import { applyOverlay } from '../src/modules/commands/commands.service.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities, setHeartbeat } from './support/caps.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, idem, issueCommand, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

const now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let siteId: string;
let roomId: string;
let otherRoomId: string;
let teacher: string;

const ALL = { 'classroom.message': { state: 'available' }, 'classroom.overlay': { state: 'available' } };

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  teacher = await loginAs(app, 'teacher1');
});
afterAll(async () => {
  await app?.close();
});

// online: oxirgi heartbeat hozir; offline: 31 s oldin.
async function device(opts: { room?: string; caps?: Record<string, { state: string }> | null; online?: boolean } = {}) {
  const id = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId: opts.room ?? roomId });
  if (opts.caps !== null) await setCapabilities(app.db.db, orgId, id, opts.caps ?? ALL);
  await setHeartbeat(app.db.db, id, opts.online === false ? now - 31_000 : now);
  return id;
}
const lessonIn = async (room = roomId, cookie = teacher) => (await startLesson(app, cookie, room)).json;
const statuses = (json: { targets: { deviceId: string; status: string; reason: string | null }[] }) =>
  Object.fromEntries(json.targets.map((t) => [t.deviceId, t.reason ? `${t.status}/${t.reason}` : t.status]));

describe('commands', () => {
  test('teacher sends a message to the whole lesson', async () => {
    const d1 = await device();
    const d2 = await device();
    const lesson = await lessonIn();
    const res = await issueCommand(app, teacher, lesson.id, { type: 'message.show', payload: { text: 'Salom' } });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({
      lessonId: lesson.id,
      type: 'message.show',
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    expect(statuses(res.json)).toEqual({ [d1]: 'pending', [d2]: 'pending' });
    expect(res.json.summary).toEqual({
      pending: 2,
      sent: 0,
      acknowledged: 0,
      succeeded: 0,
      failed: 0,
      expired: 0,
      cancelled: 0,
    });
    const got = await app.request('GET', `/api/v1/commands/${res.json.id}`, { cookie: teacher });
    expect(got.status).toBe(200);
    expect(got.json).toEqual(res.json);
    const [created] = await app.db.db.select().from(events).where(eq(events.type, 'command.created'));
    expect(created?.data).toMatchObject({ commandId: res.json.id, type: 'message.show' });
    const audit = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'command.issue'));
    expect(audit[0]?.details).toEqual({ type: 'message.show', targetCount: 2 });
    const notify = await app.db.db.select().from(outbox).where(eq(outbox.topic, 'notify.devices'));
    expect(notify.at(-1)?.payload).toEqual({ deviceIds: [d1, d2].sort() });
  });

  test('targets outside the lesson are denied', async () => {
    const inLesson = await device();
    const elsewhere = await device({ room: otherRoomId });
    const lesson = await lessonIn();
    const res = await issueCommand(app, teacher, lesson.id, {
      type: 'overlay.lock',
      payload: {},
      targetDeviceIds: [inLesson, elsewhere],
    });
    expect(res.status).toBe(403);
    const denied = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'command.issue'), eq(auditEvents.result, 'denied')));
    expect(denied).toHaveLength(1);

    await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [otherRoomId, roomId] });
    const teacher2 = await loginAs(app, 'teacher2');
    // Xonada bo'lsa ham boshqa teacher darsiga buyruq bera olmaydi.
    expect((await issueCommand(app, teacher2, lesson.id, { type: 'overlay.unlock', payload: {} })).status).toBe(403);
    expect(await app.db.db.select().from(commands)).toHaveLength(0);
  });

  test('mixed fleet yields per-target results', async () => {
    const ready = await device();
    const offline = await device({ online: false });
    const needsPermission = await device({ caps: { 'classroom.overlay': { state: 'requires_permission' } } });
    const noReport = await device({ caps: null });
    const lesson = await lessonIn();
    const res = await issueCommand(app, teacher, lesson.id, { type: 'overlay.lock', payload: { message: 'Diqqat' } });
    expect(res.status).toBe(202);
    expect(statuses(res.json)).toEqual({
      [ready]: 'pending',
      [offline]: 'pending',
      [needsPermission]: 'failed/permission_required',
      [noReport]: 'failed/unsupported',
    });
    expect(res.json.summary).toMatchObject({ pending: 2, failed: 2, succeeded: 0 });
  });

  test('all offline targets is device_offline', async () => {
    await device({ online: false });
    await device({ online: false });
    const lesson = await lessonIn();
    const res = await issueCommand(app, teacher, lesson.id, { type: 'message.show', payload: { text: 'x' } });
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('device_offline');
    expect(await app.db.db.select().from(commands)).toHaveLength(0);
  });

  test('no capable target is capability_unavailable', async () => {
    await device({ caps: { 'classroom.overlay': { state: 'unsupported' } } });
    await device({ caps: null });
    const lesson = await lessonIn();
    const res = await issueCommand(app, teacher, lesson.id, { type: 'overlay.lock', payload: {} });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('capability_unavailable');
    expect(await app.db.db.select().from(commands)).toHaveLength(0);
  });

  test('retried command is created once', async () => {
    await device();
    const lesson = await lessonIn();
    const key = idem();
    const body = { type: 'message.show', payload: { text: 'Salom' } };
    const a = await issueCommand(app, teacher, lesson.id, body, key);
    const b = await issueCommand(app, teacher, lesson.id, body, key);
    expect(b.status).toBe(202);
    expect(b.json.id).toBe(a.json.id);
    expect(await app.db.db.select().from(commands)).toHaveLength(1);
  });

  test('command to an ended lesson conflicts', async () => {
    await device();
    const lesson = await lessonIn();
    await endLesson(app, teacher, lesson.id);
    const res = await issueCommand(app, teacher, lesson.id, { type: 'overlay.unlock', payload: {} });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
  });

  test('overlay lock records desired overlay state', async () => {
    const ready = await device();
    const unsupported = await device({ caps: { 'classroom.message': { state: 'available' } } });
    const lesson = await lessonIn();
    const lock = (await issueCommand(app, teacher, lesson.id, { type: 'overlay.lock', payload: {} })).json;
    const rows = async () =>
      Object.fromEntries(
        (await app.db.db.select().from(lessonDevices)).map((r) => [r.deviceId, [r.overlayLocked, r.overlaySeq]]),
      );
    expect(await rows()).toEqual({ [ready]: [true, Number(lock.sequence)], [unsupported]: [false, null] });
    const unlock = (await issueCommand(app, teacher, lesson.id, { type: 'overlay.unlock', payload: {} })).json;
    expect(Number(unlock.sequence)).toBeGreaterThan(Number(lock.sequence));
    expect((await rows())[ready]).toEqual([false, Number(unlock.sequence)]);
  });

  test('command status is visible only to teachers of the room', async () => {
    await device();
    const lesson = await lessonIn();
    const cmd = (await issueCommand(app, teacher, lesson.id, { type: 'overlay.unlock', payload: {} })).json;
    await seedUser(app.db.db, orgId, 'teacher3', [{ role: 'teacher', siteId }], { roomIds: [otherRoomId] });
    const outsider = await loginAs(app, 'teacher3');
    expect((await app.request('GET', `/api/v1/commands/${cmd.id}`, { cookie: outsider })).status).toBe(403);
    expect((await app.request('GET', '/api/v1/commands/not-a-uuid', { cookie: teacher })).status).toBe(403);
  });

  test('overlay unlock reaches an offline class', async () => {
    const d = await device();
    const lesson = await lessonIn();
    await issueCommand(app, teacher, lesson.id, { type: 'overlay.lock', payload: {} });
    await setHeartbeat(app.db.db, d, now - 31_000);
    // Unlock xavfsiz yo'nalish: offline sinf uchun ham istalgan holat yoziladi (503 emas).
    const res = await issueCommand(app, teacher, lesson.id, { type: 'overlay.unlock', payload: {} });
    expect(res.status).toBe(202);
    const [row] = await app.db.db.select().from(lessonDevices);
    expect(row).toMatchObject({ overlayLocked: false, overlaySeq: Number(res.json.sequence) });
  });

  test('an older overlay command never overrides a newer one', async () => {
    const d = await device();
    const lesson = await lessonIn();
    await app.db.db.transaction((tx) => applyOverlay(tx, lesson.id, [d], false, 6));
    await app.db.db.transaction((tx) => applyOverlay(tx, lesson.id, [d], true, 5));
    const [row] = await app.db.db.select().from(lessonDevices);
    expect(row).toMatchObject({ overlayLocked: false, overlaySeq: 6 });
  });

  test('retry after the lesson ended replays the stored response', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const key = idem();
    const body = { type: 'message.show', payload: { text: 'x' }, targetDeviceIds: [d] };
    const first = await issueCommand(app, teacher, lesson.id, body, key);
    await endLesson(app, teacher, lesson.id);
    const retry = await issueCommand(app, teacher, lesson.id, body, key);
    expect(retry.status).toBe(202);
    expect(retry.json.id).toBe(first.json.id);
  });
});
