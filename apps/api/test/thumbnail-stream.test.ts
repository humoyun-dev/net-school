import { THUMBNAIL_INTERVAL_MS, THUMBNAIL_STREAM_MAX_BUFFER } from '@netschool/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { auditEvents } from '../src/db/schema.ts';
import { ThumbnailStore } from '../src/modules/thumbnails/thumbnail-store.ts';
import { pushFrame, ThumbnailStream } from '../src/modules/thumbnails/thumbnail-stream.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let now = 1_900_000_000_000;
let app: TestApp;
let store: ThumbnailStore;
let orgId: string;
let siteId: string;
let roomId: string;
let teacher: string;
let lessonId: string;
let deviceId: string;
let otherDeviceId: string;
const open: WebSocket[] = [];

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, 0xff, n]);
const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
  store = app.get<ThumbnailStore>(ThumbnailStore);
});
beforeEach(async () => {
  now += 3_600_000;
  for (const ws of open.splice(0)) ws.terminate();
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  const otherRoom = await seedRoom(app.db.db, orgId, siteId, '102');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [otherRoom] });
  teacher = await loginAs(app, 'teacher1');
  deviceId = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId });
  otherDeviceId = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId: otherRoom });
  lessonId = (await startLesson(app, teacher, roomId)).json.id;
});
afterAll(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await app?.close();
});

function connect(cookie: string, opts: { origin?: string; lesson?: string } = {}) {
  const url = `${app.origin.replace('https:', 'wss:')}/api/v1/lessons/${opts.lesson ?? lessonId}/thumbnails/stream`;
  const ws = new WebSocket(url, { ca: app.ca, headers: { cookie, origin: opts.origin ?? app.origin } });
  ws.on('error', () => {});
  open.push(ws);
  const frames: { deviceId: string; jpeg: Buffer }[] = [];
  ws.on('message', (data: Buffer, isBinary) => {
    if (!isBinary) return;
    const id = data.subarray(0, 16).toString('hex');
    frames.push({
      deviceId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
      jpeg: data.subarray(16),
    });
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  return { ws, frames, opened, closed };
}

async function until(check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('teacher thumbnail stream', () => {
  test('the lesson owner receives frames tagged with the device id', async () => {
    store.put(deviceId, lessonId, jpeg(1));
    const c = connect(teacher);
    await c.opened;
    await until(() => c.frames.length === 1);
    expect(c.frames[0]).toEqual({ deviceId, jpeg: jpeg(1) });
    now += THUMBNAIL_INTERVAL_MS;
    store.put(deviceId, lessonId, jpeg(2));
    await until(() => c.frames.length === 2);
    expect(c.frames[1]?.jpeg).toEqual(jpeg(2));
    // Boshqa dars a'zosi bo'lmagan qurilma kadri yuborilmaydi.
    store.put(otherDeviceId, 'other-lesson', jpeg(9));
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames).toHaveLength(2);
  });

  test('another teacher is refused and audited', async () => {
    const other = await loginAs(app, 'teacher2');
    await expect(connect(other).opened).rejects.toThrow('status 403');
    const denied = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'remote.view'), eq(auditEvents.result, 'denied')));
    expect(denied).toHaveLength(1);
    await expect(connect('').opened).rejects.toThrow('status 401');
  });

  test('a wrong Origin is refused', async () => {
    await expect(connect(teacher, { origin: 'https://evil.example' }).opened).rejects.toThrow('status 403');
  });

  test('frames are sent at most once per interval per device', async () => {
    const c = connect(teacher);
    await c.opened;
    store.put(deviceId, lessonId, jpeg(1));
    await until(() => c.frames.length === 1);
    now += 500;
    store.put(deviceId, lessonId, jpeg(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(c.frames).toHaveLength(1);
  });

  test('a slow viewer gets frames dropped, not buffered', () => {
    const sent: Buffer[] = [];
    const slow = { bufferedAmount: THUMBNAIL_STREAM_MAX_BUFFER + 1, send: (b: Buffer) => sent.push(b) };
    expect(pushFrame(slow, deviceId, jpeg(1))).toBe('dropped');
    expect(sent).toHaveLength(0);
    const fast = { bufferedAmount: 0, send: (b: Buffer) => sent.push(b) };
    expect(pushFrame(fast, deviceId, jpeg(1))).toBe('sent');
    expect(sent[0]).toEqual(Buffer.concat([uuidBytes(deviceId), jpeg(1)]));
  });

  test('ending the lesson closes the stream with 4410', async () => {
    const c = connect(teacher);
    await c.opened;
    await endLesson(app, teacher, lessonId);
    await app.get<ThumbnailStream>(ThumbnailStream).recheck();
    expect(await c.closed).toBe(4410);
  });

  test('a revoked session closes the stream with 4401', async () => {
    const c = connect(teacher);
    await c.opened;
    await app.request('POST', '/api/v1/auth/logout', { cookie: teacher });
    await app.get<ThumbnailStream>(ThumbnailStream).recheck();
    expect(await c.closed).toBe(4401);
  });

  test('an unknown upgrade path is closed with 404', async () => {
    const ws = new WebSocket(`${app.origin.replace('https:', 'wss:')}/api/v1/nope`, { ca: app.ca });
    ws.on('error', () => {});
    open.push(ws);
    const status = await new Promise<number>((resolve) =>
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(404);
  });
});
