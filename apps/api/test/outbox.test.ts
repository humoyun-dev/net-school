import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { outbox } from '../src/db/schema.ts';
import { DEVICE_NOTIFIER, type Notifier, ROOM_NOTIFIER } from '../src/modules/events/notifier.ts';
import { OutboxWorker } from '../src/modules/workers/outbox.worker.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities, setHeartbeat } from './support/caps.ts';
import { deviceRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { issueCommand, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let siteId: string;
let worker: OutboxWorker;

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
  worker = app.get<OutboxWorker>(OutboxWorker);
});
beforeEach(async () => {
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
});
afterAll(async () => {
  await app?.close();
});

const enqueue = (topic: string, payload: Record<string, unknown> = {}) =>
  app.db.db
    .insert(outbox)
    .values({ organizationId: orgId, topic, payload, createdAt: new Date(now), nextAttemptAt: new Date(now) })
    .returning()
    .then(([row]) => {
      if (!row) throw new Error('outbox');
      return row;
    });
const rowOf = async (id: number) => (await app.db.db.select().from(outbox).where(eq(outbox.id, id)))[0];

describe('outbox worker', () => {
  test('outbox rows wake waiting devices and rooms', async () => {
    const woken: string[] = [];
    const devicesWait = app
      .get<Notifier>(DEVICE_NOTIFIER)
      .wait('d-1', 5_000)
      .then(() => woken.push('d-1'));
    const roomsWait = app
      .get<Notifier>(ROOM_NOTIFIER)
      .wait('r-1', 5_000)
      .then(() => woken.push('r-1'));
    const a = await enqueue('notify.devices', { deviceIds: ['d-1'] });
    const b = await enqueue('notify.rooms', { roomIds: ['r-1'] });
    expect(await worker.tick(now)).toBe(2);
    await Promise.all([devicesWait, roomsWait]);
    expect(woken.sort()).toEqual(['d-1', 'r-1']);
    expect((await rowOf(a.id))?.processedAt?.getTime()).toBe(now);
    expect((await rowOf(b.id))?.processedAt).not.toBeNull();
    expect(await worker.tick(now)).toBe(0);
  });

  test('failed handler retries with backoff', async () => {
    let calls = 0;
    worker.register('test.flaky', () => {
      calls += 1;
      if (calls < 3) throw new Error(`boom ${calls}`);
    });
    const row = await enqueue('test.flaky');
    await worker.tick(now);
    let r = await rowOf(row.id);
    expect(r).toMatchObject({ attempts: 1, processedAt: null, lastError: 'boom 1' });
    expect(r?.nextAttemptAt.getTime()).toBe(now + 1_000);
    expect(await worker.tick(now + 999)).toBe(0);
    await worker.tick(now + 1_000);
    r = await rowOf(row.id);
    expect(r?.attempts).toBe(2);
    expect(r?.nextAttemptAt.getTime()).toBe(now + 1_000 + 2_000);
    await worker.tick(now + 3_000);
    expect((await rowOf(row.id))?.processedAt).not.toBeNull();
    expect(calls).toBe(3);
  });

  test('rows are processed once across concurrent ticks', async () => {
    let calls = 0;
    worker.register('test.count', () => {
      calls += 1;
    });
    for (let i = 0; i < 5; i++) await enqueue('test.count');
    const done = await Promise.all([worker.tick(now), worker.tick(now), worker.tick(now)]);
    expect(done.reduce((x, y) => x + y, 0)).toBe(5);
    expect(calls).toBe(5);
  });

  test('unknown topic is retried then parked', async () => {
    const row = await enqueue('nobody.listens');
    let at = now;
    for (let i = 0; i < 10; i++) {
      await worker.tick(at);
      at += 60_000;
    }
    const parked = await rowOf(row.id);
    expect(parked).toMatchObject({ attempts: 10, processedAt: null });
    expect(parked?.lastError).toMatch(/nobody\.listens/);
    expect(await worker.tick(at + 3_600_000)).toBe(0);
    expect((await rowOf(row.id))?.attempts).toBe(10);
  });

  test('issued command reaches a long-polling device through the worker', async () => {
    const roomId = await seedRoom(app.db.db, orgId, siteId, '101');
    await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    const teacher = await loginAs(app, 'teacher1');
    const key = makeDeviceKey();
    const deviceId = await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId });
    await setCapabilities(app.db.db, orgId, deviceId, { 'classroom.message': { state: 'available' } });
    await setHeartbeat(app.db.db, deviceId, now);
    const lesson = (await startLesson(app, teacher, roomId)).json;
    await worker.tick(now);
    now += 1;
    const waiting = deviceRequest(app, key, deviceId, 'GET', '/api/v1/device/commands?wait=5', undefined, now);
    await new Promise((r) => setTimeout(r, 200));
    const cmd = (await issueCommand(app, teacher, lesson.id, { type: 'message.show', payload: { text: 'Salom' } }))
      .json;
    const started = Date.now();
    await worker.tick(now);
    const res = await waiting;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.json.commands.map((c: { commandId: string }) => c.commandId)).toEqual([cmd.id]);
  });
});
