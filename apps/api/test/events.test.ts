import { lte } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { events } from '../src/db/schema.ts';
import { type Notifier, ROOM_NOTIFIER } from '../src/modules/events/notifier.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities, setHeartbeat } from './support/caps.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { issueCommand, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

const now = 1_800_000_000_000;
let app: TestApp;
let roomId: string;
let otherRoomId: string;
let teacher: string;
let admin: string;

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  await app.db.reset();
  const { orgId, siteId } = await seedOrg(app.db.db);
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  teacher = await loginAs(app, 'teacher1');
  admin = await loginAs(app, 'admin1');
  for (const room of [roomId, otherRoomId]) {
    const id = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId: room });
    await setCapabilities(app.db.db, orgId, id, { 'classroom.message': { state: 'available' } });
    await setHeartbeat(app.db.db, id, now);
  }
});
afterAll(async () => {
  await app?.close();
});

const poll = (query: string, cookie = teacher) => app.request('GET', `/api/v1/events?${query}`, { cookie });
const message = (lessonId: string, cookie = teacher) =>
  issueCommand(app, cookie, lessonId, { type: 'message.show', payload: { text: 'x' } }).then((r) => r.json);

describe('events', () => {
  test('first call returns a snapshot and cursor', async () => {
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const cmd = await message(lesson.id);
    const res = await poll(`roomId=${roomId}`);
    expect(res.status).toBe(200);
    expect(res.json.resync).toBe(true);
    expect(res.json.events).toEqual([]);
    expect(res.json.snapshot.lesson.id).toBe(lesson.id);
    expect(res.json.snapshot.commands.map((c: { id: string }) => c.id)).toEqual([cmd.id]);
    const roomSeqs = (await app.db.db.select().from(events)).filter((e) => e.roomId === roomId).map((e) => e.seq);
    expect(res.json.cursor).toBe(String(Math.max(...roomSeqs)));
    const empty = await poll(`roomId=${roomId}`, admin);
    expect(empty.json.snapshot.lesson.id).toBe(lesson.id);
  });

  test('cursor returns only newer events of the room', async () => {
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const { cursor } = (await poll(`roomId=${roomId}`)).json;
    const other = (await startLesson(app, admin, otherRoomId)).json;
    await message(other.id, admin);
    const cmd = await message(lesson.id);
    const res = await poll(`roomId=${roomId}&after=${cursor}`);
    expect(res.json.resync).toBe(false);
    expect(res.json.snapshot).toBeUndefined();
    expect(
      res.json.events.map((e: { type: string; data: { commandId: string } }) => [e.type, e.data.commandId]),
    ).toEqual([['command.created', cmd.id]]);
    expect(res.json.cursor).toBe(res.json.events[0].seq);
    const again = await poll(`roomId=${roomId}&after=${res.json.cursor}`);
    expect(again.json.events).toEqual([]);
    expect(again.json.cursor).toBe(res.json.cursor);
  });

  test('purged cursor forces a resync', async () => {
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const { cursor } = (await poll(`roomId=${roomId}`)).json;
    await message(lesson.id);
    await message(lesson.id);
    const all = await app.db.db.select().from(events);
    const purgeUpTo = Math.max(...all.map((e) => e.seq)) - 1;
    await app.db.db.delete(events).where(lte(events.seq, purgeUpTo));
    const res = await poll(`roomId=${roomId}&after=${cursor}`);
    expect(res.json.resync).toBe(true);
    expect(res.json.snapshot.lesson.id).toBe(lesson.id);
    expect((await poll(`roomId=${roomId}&after=not-a-number`)).status).toBe(400);
  });

  test('long poll wakes on a new event', async () => {
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const { cursor } = (await poll(`roomId=${roomId}`)).json;
    const waiting = poll(`roomId=${roomId}&after=${cursor}&wait=5`);
    await new Promise((r) => setTimeout(r, 200));
    await message(lesson.id);
    const started = Date.now();
    app.get<Notifier>(ROOM_NOTIFIER).wake([roomId]);
    const res = await waiting;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.json.events.map((e: { type: string }) => e.type)).toEqual(['command.created']);
  });

  test('teacher of another room is denied', async () => {
    expect((await poll(`roomId=${otherRoomId}`)).status).toBe(403);
    expect((await poll('roomId=not-a-uuid')).status).toBe(403);
  });
});
