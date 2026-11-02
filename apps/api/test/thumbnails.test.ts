import type { Server } from 'node:net';
import { type ConnectionOptions, connect } from 'node:tls';
import { HttpAdapterHost } from '@nestjs/core';
import { count, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { auditEvents, devices, events, outbox } from '../src/db/schema.ts';
import { ThumbnailStore } from '../src/modules/thumbnails/thumbnail-store.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { type DeviceKey, makeDeviceKey, seedDevice, signingInput } from './support/device.ts';
import { endLesson, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

const PATH = '/api/v1/device/thumbnails';

let now = 1_800_000_000_000;
let app: TestApp;
let store: ThumbnailStore;
let orgId: string;
let siteId: string;
let roomId: string;
let otherRoomId: string;
let lessonId: string;
let admin: string;
let teacher: string;
let sessions = new Map<string, string>();
let device: { id: string; key: DeviceKey };
const sockets: WebSocket[] = [];

// Kirish IP bo'yicha cheklanadi (30/daqiqa): har test yangi oynada boshlanadi va foydalanuvchini bir marta kiritadi.
async function loginOnce(username: string): Promise<string> {
  const known = sessions.get(username);
  if (known) return known;
  const cookie = await loginAs(app, username);
  sessions.set(username, cookie);
  return cookie;
}

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
  store = app.get(ThumbnailStore);
});
beforeEach(async () => {
  now += 60_000;
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [otherRoomId] });
  await seedUser(app.db.db, orgId, 'it1', [{ role: 'it_support', siteId }]);
  sessions = new Map();
  admin = await loginOnce('admin1');
  teacher = await loginOnce('teacher1');
  const key = makeDeviceKey();
  device = { id: await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId }), key };
  lessonId = (await startLesson(app, teacher, roomId)).json.id;
});
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
});
afterAll(async () => {
  await app?.close();
});

function jpeg(tag: number, size = 16): Buffer {
  const frame = Buffer.alloc(size, tag);
  frame.set([0xff, 0xd8, 0xff]);
  return frame;
}

function signedHeaders(d: { id: string; key: DeviceKey }, path = PATH, ts = ++now) {
  return {
    'x-ns-device-id': d.id,
    'x-ns-timestamp': String(ts),
    'x-ns-signature': d.key.sign(signingInput('GET', path, ts, '')),
  };
}

// Upgrade urinishi: ochilgan soket yoki rad javobining statusi.
function attempt(headers: Record<string, string>, path = PATH): Promise<{ ws: WebSocket } | { status: number }> {
  return new Promise((resolve, reject) => {
    const port = new URL(app.origin).port;
    const ws = new WebSocket(`wss://localhost:${port}${path}`, { ca: app.ca, headers });
    sockets.push(ws);
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
    });
    ws.once('error', (err) => {
      // 'unexpected-response' bo'lmagan xato (masalan, TLS) — test muvaffaqiyatsiz.
      if (!/Unexpected server response/.test(err.message)) reject(err);
    });
  });
}

async function open(d = device, headers = signedHeaders(d)): Promise<WebSocket> {
  const res = await attempt(headers);
  if (!('ws' in res)) throw new Error(`upgrade refused: ${res.status}`);
  return res.ws;
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const send = (ws: WebSocket, data: Buffer) =>
  new Promise<void>((resolve, reject) => ws.send(data, (e) => (e ? reject(e) : resolve())));

// Ping/pong kafolat beradi: undan oldin yuborilgan kadrlar serverda qayta ishlab bo'lingan (soat shundan keyin suriladi).
async function settle(ws: WebSocket): Promise<void> {
  const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
  ws.ping();
  await pong;
}

describe('thumbnail ingest', () => {
  test('a lesson device streams frames and only the latest is kept', async () => {
    const ws = await open();
    const first = jpeg(1);
    await send(ws, first);
    await until(() => store.latest(device.id, lessonId) !== null, 'first frame');
    expect(store.latest(device.id, lessonId)).toMatchObject({ seq: 1, at: now });
    expect(store.latest(device.id, lessonId)?.jpeg.equals(first)).toBe(true);

    now += 400;
    const second = jpeg(2, 32);
    await send(ws, second);
    await until(() => store.latest(device.id, lessonId)?.seq === 2, 'second frame');
    expect(store.latest(device.id, lessonId)?.jpeg.equals(second)).toBe(true);

    // Boshqa dars uchun berilmaydi; TTL o'tgach ham.
    expect(store.latest(device.id, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(store.latest(device.id, lessonId)).not.toBeNull();
    now += 10_001;
    expect(store.latest(device.id, lessonId)).toBeNull();
    store.sweep();
    now -= 10_001;
    expect(store.latest(device.id, lessonId)).toBeNull();
  });

  test('an unsigned, replayed or retired-device upgrade is refused with 401', async () => {
    expect(await attempt({})).toEqual({ status: 401 });

    const ts = ++now;
    const headers = signedHeaders(device, PATH, ts);
    (await open(device, headers)).close();
    expect(await attempt(headers)).toEqual({ status: 401 });

    // Boshqa yo'l uchun imzolangan sarlavha bu yo'lda yaramaydi.
    expect(await attempt(signedHeaders(device, '/api/v1/device/heartbeat'))).toEqual({ status: 401 });

    await app.db.db
      .update(devices)
      .set({ retiredAt: new Date(now) })
      .where(eq(devices.id, device.id));
    expect(await attempt(signedHeaders(device))).toEqual({ status: 401 });
  });

  test('an upgrade to another path is refused with 400', async () => {
    expect(await attempt(signedHeaders(device, '/api/v1/device/other'), '/api/v1/device/other')).toEqual({
      status: 400,
    });
  });

  test.each([
    ['unsigned', PATH, 401],
    ['another path', '/api/v1/device/other', 400],
  ])('a refused %s upgrade does not keep the socket open', async (_name, path, status) => {
    const server: Server = app.get<HttpAdapterHost>(HttpAdapterHost).httpAdapter.getHttpServer();
    const openConnections = () => new Promise<number>((resolve) => server.getConnections((_e, n) => resolve(n)));
    // allowHalfOpen: mijoz o'z tomonini yopmaydi; server o'zi soketni tugatishi shart.
    const client = connect({
      host: '127.0.0.1',
      port: Number(new URL(app.origin).port),
      servername: 'localhost',
      ca: app.ca,
      allowHalfOpen: true, // @types/node bu tls opsiyasini bilmaydi, lekin runtime qo'llaydi
    } as ConnectionOptions);
    sockets.push({ terminate: () => client.destroy() } as unknown as WebSocket);
    await new Promise<void>((resolve) => client.once('secureConnect', () => resolve()));
    const connected = await openConnections();
    let head = '';
    client.on('data', (chunk) => {
      head += chunk.toString('latin1');
    });
    client.write(
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );
    await until(() => head.startsWith(`HTTP/1.1 ${status} `), 'refusal response');
    for (let i = 0; i < 100 && (await openConnections()) >= connected; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await openConnections()).toBeLessThan(connected);
  });

  test('a device outside an active lesson cannot open the stream', async () => {
    const key = makeDeviceKey();
    const idle = { id: await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId: otherRoomId }), key };
    expect(await attempt(signedHeaders(idle))).toEqual({ status: 409 });
  });

  test('frames faster than the minimum interval are dropped', async () => {
    const ws = await open();
    await send(ws, jpeg(1));
    await until(() => store.latest(device.id, lessonId)?.seq === 1, 'first frame');
    await send(ws, jpeg(2)); // aynan shu soniyada: tashlanadi
    await settle(ws);
    now += 399;
    await send(ws, jpeg(3)); // 399 ms: hali tez
    await settle(ws);
    now += 1;
    const last = jpeg(4);
    await send(ws, last); // 400 ms: qabul
    await until(() => store.latest(device.id, lessonId)?.seq === 2, 'frame after interval');
    // Tashlangan kadrlar ketma-ketlikni oshirmagan: ikkinchi saqlangan kadr aynan oxirgisi.
    expect(store.latest(device.id, lessonId)?.jpeg.equals(last)).toBe(true);
  });

  test('oversized frames close the stream and non-JPEG frames are ignored', async () => {
    const ws = await open();
    await send(ws, Buffer.from('not a jpeg at all'));
    await settle(ws);
    now += 400;
    const good = jpeg(7);
    await send(ws, good);
    await until(() => store.latest(device.id, lessonId) !== null, 'jpeg after garbage');
    expect(store.latest(device.id, lessonId)).toMatchObject({ seq: 1 });
    expect(store.latest(device.id, lessonId)?.jpeg.equals(good)).toBe(true);

    const text = await open(device, signedHeaders(device));
    const textClosed = closed(text);
    text.send('hello');
    expect((await textClosed).code).toBe(1003);

    const big = await open(device, signedHeaders(device));
    const bigClosed = closed(big);
    now += 400;
    await send(big, jpeg(9, 262_145));
    expect((await bigClosed).code).toBe(1009);
    expect(store.latest(device.id, lessonId)?.jpeg.equals(good)).toBe(true);
  });

  test('a second stream from the same device replaces the first', async () => {
    const first = await open();
    const firstClosed = closed(first);
    const second = await open();
    expect(await firstClosed).toEqual({ code: 4000, reason: 'replaced' });
    now += 400;
    await send(second, jpeg(5));
    await until(() => store.latest(device.id, lessonId) !== null, 'frame on the new stream');
  });

  test('the stream closes once the device has left the lesson', async () => {
    const ws = await open();
    await send(ws, jpeg(1));
    await until(() => store.latest(device.id, lessonId) !== null, 'first frame');
    const moved = await app.request('PUT', `/api/v1/devices/${device.id}/room`, {
      body: { roomId: otherRoomId },
      cookie: admin,
    });
    expect(moved.status).toBe(200);

    // 5 s dan oldin a'zolik qayta tekshirilmaydi, kadr qabul qilinadi.
    now += 4_000;
    await send(ws, jpeg(2));
    await until(() => store.latest(device.id, lessonId)?.seq === 2, 'frame inside the recheck window');

    now += 1_000;
    const gone = closed(ws);
    await send(ws, jpeg(3));
    expect(await gone).toEqual({ code: 4409, reason: 'left_lesson' });
    expect(store.latest(device.id, lessonId)?.seq).toBe(2);
  });

  test('frames leave no trace in the database', async () => {
    const tally = async () => ({
      events: (await app.db.db.select({ n: count() }).from(events))[0]?.n,
      outbox: (await app.db.db.select({ n: count() }).from(outbox))[0]?.n,
      audit: (await app.db.db.select({ n: count() }).from(auditEvents))[0]?.n,
    });
    const before = await tally();
    const ws = await open();
    for (let i = 0; i < 3; i++) {
      now += 400;
      await send(ws, jpeg(i));
      await settle(ws);
    }
    await until(() => store.latest(device.id, lessonId)?.seq === 3, 'three frames');
    expect(await tally()).toEqual(before);
  });
});

const thumbnailPath = (lesson: string, deviceId: string) => `/api/v1/lessons/${lesson}/devices/${deviceId}/thumbnail`;
const read = (cookie: string, lesson = lessonId, deviceId = device.id) =>
  app.request('GET', thumbnailPath(lesson, deviceId), { cookie });
const deniedAudits = () => app.db.db.select().from(auditEvents).where(eq(auditEvents.result, 'denied'));

describe('thumbnail read', () => {
  test('the lesson owner reads the latest frame', async () => {
    const ws = await open();
    await send(ws, jpeg(1));
    await until(() => store.latest(device.id, lessonId)?.seq === 1, 'first frame');
    now += 400;
    const last = jpeg(2, 40);
    await send(ws, last);
    await until(() => store.latest(device.id, lessonId)?.seq === 2, 'second frame');

    const auditsBefore = (await app.db.db.select({ n: count() }).from(auditEvents))[0]?.n;
    for (const cookie of [teacher, admin]) {
      const res = await read(cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-ns-frame-seq')).toBe('2');
      expect(res.headers.get('x-ns-frame-at')).toBe(new Date(now).toISOString());
      expect(res.headers.get('x-correlation-id')).toBeTruthy();
      expect(res.bytes.equals(last)).toBe(true);
    }
    // Muvaffaqiyatli o'qish audit qilinmaydi.
    expect((await app.db.db.select({ n: count() }).from(auditEvents))[0]?.n).toBe(auditsBefore);
  });

  test('a lesson device without a frame has no thumbnail', async () => {
    const res = await read(teacher);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });

  test('a frame from a previous lesson is never served in the next one', async () => {
    const ws = await open();
    await send(ws, jpeg(1));
    await until(() => store.latest(device.id, lessonId) !== null, 'frame in the first lesson');
    expect((await read(teacher)).status).toBe(200);

    expect((await endLesson(app, teacher, lessonId)).status).toBe(200);
    const next = (await startLesson(app, teacher, roomId)).json.id;
    expect(next).not.toBe(lessonId);
    const res = await read(teacher, next);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });

  test('frames older than ten seconds are not served', async () => {
    const ws = await open();
    await send(ws, jpeg(1));
    await until(() => store.latest(device.id, lessonId) !== null, 'frame');
    now += 10_000;
    expect((await read(teacher)).status).toBe(200);
    now += 1;
    const res = await read(teacher);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });

  test('another teacher or it_support cannot read thumbnails', async () => {
    const ws = await open();
    await send(ws, jpeg(1));
    await until(() => store.latest(device.id, lessonId) !== null, 'frame');
    for (const cookie of [await loginOnce('teacher2'), await loginOnce('it1')]) {
      const res = await read(cookie);
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('scope_denied');
      expect(res.bytes.includes(jpeg(1).subarray(0, 3))).toBe(false);
    }
    const audits = await deniedAudits();
    expect(audits).toHaveLength(2);
    expect(audits.every((e) => e.action === 'remote.view' && e.targetType === 'lesson')).toBe(true);
  });

  test('unknown or malformed ids are denied like a foreign lesson', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const [lesson, deviceId] of [
      [unknown, device.id],
      ['not-a-uuid', device.id],
      [lessonId, unknown],
      [lessonId, 'not-a-uuid'],
    ] as const) {
      const res = await read(teacher, lesson, deviceId);
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('scope_denied');
    }
    expect(await deniedAudits()).toHaveLength(4);
  });

  test('a device that is not in the lesson has no thumbnail', async () => {
    const key = makeDeviceKey();
    const idle = { id: await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId: otherRoomId }), key };
    const res = await read(teacher, lessonId, idle.id);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('scope_denied');
    const audits = await deniedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'remote.view', targetType: 'device', targetId: idle.id });
  });

  test('a device that left the lesson no longer has a thumbnail', async () => {
    const ws = await open();
    await send(ws, jpeg(1));
    await until(() => store.latest(device.id, lessonId) !== null, 'frame');
    const moved = await app.request('PUT', `/api/v1/devices/${device.id}/room`, {
      body: { roomId: otherRoomId },
      cookie: admin,
    });
    expect(moved.status).toBe(200);
    expect((await read(teacher)).status).toBe(403);
  });
});
