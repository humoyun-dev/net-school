import { remoteSessionSchema } from '@netschool/contracts';
import { eq, lte } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { events, sites } from '../src/db/schema.ts';
import { type Notifier, ROOM_NOTIFIER } from '../src/modules/events/notifier.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities, setHeartbeat } from './support/caps.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, idem, issueCommand, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { FakeRemote, seedBinding } from './support/remote.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

const base = 1_800_000_000_000;
let now = base;
const mesh = new FakeMesh();
const remote = new FakeRemote();
let app: TestApp;
let orgId: string;
let siteId: string;
let adminId: string;
let roomId: string;
let otherRoomId: string;
let teacher: string;
let admin: string;

beforeAll(async () => {
  app = await startTestApp({ now: () => now, deviceManagement: mesh.factory, remote: remote.upstream });
});
beforeEach(async () => {
  now = base;
  mesh.nodes.clear();
  remote.reset();
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  await app.db.db.update(sites).set({ meshDomainId: 'dom-a' }).where(eq(sites.id, siteId));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  adminId = await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
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

// MeshCentral'da bog'langan, online qurilma; remote sessiya ochishga tayyor.
async function remoteDevice(room: string) {
  const id = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId: room });
  const meshNodeId = `node-${id}`;
  mesh.nodes.set(meshNodeId, { domain: 'dom-a', name: 'pc', online: true });
  await seedBinding(app.db.db, { orgId, siteId, deviceId: id, meshDomainId: 'dom-a', meshNodeId, boundBy: adminId });
  await setCapabilities(app.db.db, orgId, id, { 'remote.desktop': { state: 'available' } });
  return id;
}
const openRemote = (cookie: string, lessonId: string, deviceId: string, mode: 'view' | 'control' = 'view') =>
  app.request('POST', `/api/v1/lessons/${lessonId}/remote-sessions`, {
    body: { deviceId, mode },
    cookie,
    headers: idem(),
  });

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

  test('snapshot lists open remote sessions of the active lesson', async () => {
    const [d1, d2, d3, otherDevice] = [
      await remoteDevice(roomId),
      await remoteDevice(roomId),
      await remoteDevice(roomId),
      await remoteDevice(otherRoomId),
    ] as [string, string, string, string];
    // Oldingi (tugagan) darsning sessiyasi snapshot'ga kirmasligi kerak.
    const previous = (await startLesson(app, teacher, roomId)).json;
    expect((await openRemote(teacher, previous.id, d1)).status).toBe(201);
    expect((await endLesson(app, teacher, previous.id)).status).toBe(200);
    now += 1_000;
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const first = (await openRemote(teacher, lesson.id, d1, 'control')).json;
    now += 1_000;
    const closing = (await openRemote(teacher, lesson.id, d2)).json;
    now += 1_000;
    const second = (await openRemote(teacher, lesson.id, d3)).json;
    expect((await app.request('DELETE', `/api/v1/remote-sessions/${closing.id}`, { cookie: teacher })).status).toBe(
      204,
    );
    // Boshqa xonaning darsi.
    const other = (await startLesson(app, admin, otherRoomId)).json;
    expect((await openRemote(admin, other.id, otherDevice)).status).toBe(201);

    const res = await poll(`roomId=${roomId}`);
    expect(res.status).toBe(200);
    const listed = res.json.snapshot.remoteSessions;
    for (const s of listed) expect(() => remoteSessionSchema.parse(s)).not.toThrow();
    expect(listed.map((s: { id: string }) => s.id)).toEqual([first.id, second.id]);
    expect(first.lease).not.toBeNull();
    expect(listed[0]).toEqual(first);
    expect(listed[1]).toEqual(second);

    const others = await poll(`roomId=${otherRoomId}`, admin);
    expect(others.json.snapshot.remoteSessions).toHaveLength(1);

    // Dars tugagach faol dars yo'q: snapshot'da sessiya ham yo'q.
    expect((await endLesson(app, teacher, lesson.id)).status).toBe(200);
    const after = await poll(`roomId=${roomId}`);
    expect(after.json.snapshot).toEqual({ lesson: null, commands: [], remoteSessions: [] });
  });

  test('remote session open and close appear in the room stream', async () => {
    const d = await remoteDevice(roomId);
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const { cursor } = (await poll(`roomId=${roomId}`)).json;
    const session = (await openRemote(teacher, lesson.id, d)).json;
    expect((await app.request('DELETE', `/api/v1/remote-sessions/${session.id}`, { cookie: teacher })).status).toBe(
      204,
    );
    // Boshqa xonadagi sessiya oqimga tushmaydi.
    const otherDevice = await remoteDevice(otherRoomId);
    const other = (await startLesson(app, admin, otherRoomId)).json;
    expect((await openRemote(admin, other.id, otherDevice)).status).toBe(201);

    const res = await poll(`roomId=${roomId}&after=${cursor}`);
    expect(res.json.resync).toBe(false);
    expect(
      res.json.events.map((e: { type: string; lessonId: string; data: unknown }) => [e.type, e.lessonId, e.data]),
    ).toEqual([
      ['remote_session.opened', lesson.id, { sessionId: session.id, deviceId: d, mode: 'view' }],
      ['remote_session.closed', lesson.id, { sessionId: session.id, deviceId: d, mode: 'view', reason: 'teacher' }],
    ]);
    const snapshot = await poll(`roomId=${roomId}`);
    expect(snapshot.json.snapshot.remoteSessions).toEqual([]);
  });
});
