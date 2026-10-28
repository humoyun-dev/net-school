import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { commandReceipts, commandTargets } from '../src/db/schema.ts';
import { DEVICE_NOTIFIER, type Notifier } from '../src/modules/events/notifier.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities, setHeartbeat } from './support/caps.ts';
import { type DeviceKey, deviceRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, issueCommand, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let teacher: string;
let lessonId: string;
let a: { id: string; key: DeviceKey };
let b: { id: string; key: DeviceKey };

const CAPS = { 'classroom.message': { state: 'available' }, 'classroom.overlay': { state: 'available' } };

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  await app.db.reset();
  let siteId: string;
  ({ orgId, siteId } = await seedOrg(app.db.db));
  const roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  teacher = await loginAs(app, 'teacher1');
  const mk = async () => {
    const key = makeDeviceKey();
    const id = await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId });
    await setCapabilities(app.db.db, orgId, id, CAPS);
    await setHeartbeat(app.db.db, id, now);
    return { id, key };
  };
  a = await mk();
  b = await mk();
  lessonId = (await startLesson(app, teacher, roomId)).json.id;
});
afterAll(async () => {
  await app?.close();
});

const signed = (d: { id: string; key: DeviceKey }, method: string, path: string, body?: unknown) => {
  now += 1;
  return deviceRequest(app, d.key, d.id, method, path, body, now);
};
const pull = (d = a, wait = 0) => signed(d, 'GET', `/api/v1/device/commands?wait=${wait}`);
const receipt = (d: { id: string; key: DeviceKey }, commandId: string, body: unknown) =>
  signed(d, 'POST', `/api/v1/device/commands/${commandId}/receipt`, body);
const issue = async (body: unknown) => (await issueCommand(app, teacher, lessonId, body)).json;
const targetOf = async (commandId: string, deviceId: string) =>
  (await app.db.db.select().from(commandTargets).where(eq(commandTargets.commandId, commandId))).find(
    (t) => t.deviceId === deviceId,
  );

describe('device command channel', () => {
  test('device pulls pending commands and marks them sent', async () => {
    const cmd = await issue({ type: 'message.show', payload: { text: 'Salom' }, targetDeviceIds: [a.id] });
    const res = await pull();
    expect(res.status).toBe(200);
    expect(res.json.commands).toEqual([
      {
        commandId: cmd.id,
        sequence: cmd.sequence,
        targetDeviceId: a.id,
        lessonId,
        issuedAt: cmd.issuedAt,
        expiresAt: cmd.expiresAt,
        type: 'message.show',
        payload: { text: 'Salom' },
      },
    ]);
    expect((await targetOf(cmd.id, a.id))?.status).toBe('sent');
    // Ack kelmaguncha qayta yetkaziladi (javob yo'qolsa ham buyruq yo'qolmaydi).
    expect((await pull()).json.commands).toHaveLength(1);
    expect((await pull(b)).json.commands).toEqual([]);
  });

  test('long poll returns when a command arrives', async () => {
    const waiting = pull(a, 5);
    await new Promise((r) => setTimeout(r, 200));
    const cmd = await issue({ type: 'overlay.lock', payload: {}, targetDeviceIds: [a.id] });
    app.get<Notifier>(DEVICE_NOTIFIER).wake([a.id]);
    const started = Date.now();
    const res = await waiting;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.json.commands.map((c: { commandId: string }) => c.commandId)).toEqual([cmd.id]);
  });

  test('long poll times out empty', async () => {
    const started = Date.now();
    const res = await pull(a, 1);
    expect(res.status).toBe(200);
    expect(res.json.commands).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test('receipts move a target through the lifecycle', async () => {
    const cmd = await issue({ type: 'message.show', payload: { text: 'x' }, targetDeviceIds: [a.id] });
    await pull();
    expect((await receipt(a, cmd.id, { status: 'acknowledged' })).status).toBe(204);
    expect((await targetOf(cmd.id, a.id))?.status).toBe('acknowledged');
    expect((await receipt(a, cmd.id, { status: 'succeeded' })).status).toBe(204);
    const done = await targetOf(cmd.id, a.id);
    expect(done?.status).toBe('succeeded');
    expect(done?.finishedAt?.getTime()).toBe(now);
    expect((await receipt(a, cmd.id, { status: 'succeeded' })).status).toBe(204);
    expect((await receipt(a, cmd.id, { status: 'failed', reason: 'error' })).status).toBe(409);
    expect(await app.db.db.select().from(commandReceipts)).toHaveLength(2);
    // Bajarilgan buyruq qayta yetkazilmaydi.
    expect((await pull()).json.commands).toEqual([]);
  });

  test('late receipt does not revive a cancelled target', async () => {
    const cmd = await issue({ type: 'overlay.lock', payload: {}, targetDeviceIds: [a.id] });
    await pull();
    await endLesson(app, teacher, lessonId);
    const res = await receipt(a, cmd.id, { status: 'succeeded' });
    expect(res.status).toBe(409);
    expect((await targetOf(cmd.id, a.id))?.status).toBe('cancelled');
  });

  test('expired commands are never delivered', async () => {
    await issue({ type: 'overlay.lock', payload: {}, targetDeviceIds: [a.id], ttlSeconds: 10 });
    now += 10_000;
    expect((await pull()).json.commands).toEqual([]);
  });

  test("a device cannot report on another device's target", async () => {
    const cmd = await issue({ type: 'message.show', payload: { text: 'x' }, targetDeviceIds: [a.id] });
    expect((await receipt(b, cmd.id, { status: 'succeeded' })).status).toBe(409);
    expect((await receipt(b, 'not-a-uuid', { status: 'succeeded' })).status).toBe(409);
    expect((await targetOf(cmd.id, a.id))?.status).toBe('pending');
  });

  test('heartbeat carries the overlay lease while the lesson is active', async () => {
    const lock = await issue({ type: 'overlay.lock', payload: {} });
    const res = await signed(a, 'POST', '/api/v1/device/heartbeat', {});
    expect(res.json).toEqual({
      heartbeatIntervalSeconds: 10,
      lesson: {
        id: lessonId,
        overlay: { locked: true, sequence: lock.sequence, leaseExpiresAt: new Date(now + 120_000).toISOString() },
      },
    });
  });

  test('ended lesson releases overlay on next heartbeat', async () => {
    await issue({ type: 'overlay.lock', payload: {} });
    await endLesson(app, teacher, lessonId);
    const res = await signed(a, 'POST', '/api/v1/device/heartbeat', {});
    expect(res.json).toEqual({ heartbeatIntervalSeconds: 10, lesson: null });
  });
});
