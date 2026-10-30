import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, commandTargets, events, idempotencyKeys, lessons, outbox, users } from '../src/db/schema.ts';
import { MaintenanceWorker } from '../src/modules/workers/maintenance.worker.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities, setHeartbeat } from './support/caps.ts';
import { type DeviceKey, deviceRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { issueCommand, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

const DAY = 24 * 3_600_000;
let now = 1_800_000_000_000;
let app: TestApp;
let worker: MaintenanceWorker;
let orgId: string;
let siteId: string;
let roomId: string;
let teacher: string;
let a: { id: string; key: DeviceKey };
let b: { id: string; key: DeviceKey };

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
  worker = app.get<MaintenanceWorker>(MaintenanceWorker);
});
beforeEach(async () => {
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  teacher = await loginAs(app, 'teacher1');
  const mk = async () => {
    const key = makeDeviceKey();
    const id = await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId });
    await setCapabilities(app.db.db, orgId, id, {
      'classroom.message': { state: 'available' },
      'classroom.overlay': { state: 'available' },
    });
    await setHeartbeat(app.db.db, id, now);
    return { id, key };
  };
  a = await mk();
  b = await mk();
});
afterAll(async () => {
  await app?.close();
});

const statusOf = async (deviceId: string) =>
  (await app.db.db.select().from(commandTargets).where(eq(commandTargets.deviceId, deviceId)))[0]?.status;

describe('maintenance worker', () => {
  test('targets expire at their deadline', async () => {
    const lesson = (await startLesson(app, teacher, roomId)).json;
    await issueCommand(app, teacher, lesson.id, { type: 'message.show', payload: { text: 'x' }, ttlSeconds: 10 });
    expect((await worker.tick(now + 9_999)).expiredTargets).toBe(0);
    expect((await worker.tick(now + 10_000)).expiredTargets).toBe(2);
    expect(await statusOf(a.id)).toBe('expired');
    const updates = await app.db.db.select().from(events).where(eq(events.type, 'command.target_updated'));
    expect(updates.map((e) => (e.data as { status: string }).status)).toEqual(['expired', 'expired']);
    expect((await worker.tick(now + 20_000)).expiredTargets).toBe(0);
  });

  test('expiry does not override a terminal receipt', async () => {
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const cmd = (
      await issueCommand(app, teacher, lesson.id, { type: 'message.show', payload: { text: 'x' }, ttlSeconds: 10 })
    ).json;
    now += 1;
    const res = await deviceRequest(
      app,
      a.key,
      a.id,
      'POST',
      `/api/v1/device/commands/${cmd.id}/receipt`,
      {
        status: 'succeeded',
      },
      now,
    );
    expect(res.status).toBe(204);
    await worker.tick(now + 10_000);
    expect(await statusOf(a.id)).toBe('succeeded');
    expect(await statusOf(b.id)).toBe('expired');
  });

  test('lessons end at their scheduled time and release overlay', async () => {
    const lesson = (await startLesson(app, teacher, roomId, { durationMinutes: 5 })).json;
    await issueCommand(app, teacher, lesson.id, { type: 'overlay.lock', payload: {} });
    expect((await worker.tick(now + 5 * 60_000 - 1)).endedLessons).toBe(0);
    now += 5 * 60_000;
    expect((await worker.tick(now)).endedLessons).toBe(1);
    const [row] = await app.db.db.select().from(lessons).where(eq(lessons.id, lesson.id));
    expect(row).toMatchObject({ status: 'ended', endReason: 'timeout', endedBy: null });
    const hb = await deviceRequest(app, a.key, a.id, 'POST', '/api/v1/device/heartbeat', {}, now + 1);
    expect(hb.json.lesson).toBeNull();
    const audit = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'lesson.end'), eq(auditEvents.result, 'succeeded')));
    expect(audit.map((x) => [x.actorUserId, (x.details as { reason: string }).reason])).toEqual([[null, 'timeout']]);
    expect((await worker.tick(now + 60_000)).endedLessons).toBe(0);
  });

  test('old idempotency keys, outbox rows and events are purged', async () => {
    const [user] = await app.db.db.select().from(users);
    if (!user) throw new Error('user');
    const at = (ms: number) => new Date(now - ms);
    await app.db.db.insert(idempotencyKeys).values([
      { actorUserId: user.id, scope: 's', key: 'old-key-1', requestHash: 'h', createdAt: at(DAY) },
      { actorUserId: user.id, scope: 's', key: 'new-key-1', requestHash: 'h', createdAt: at(DAY - 1) },
    ]);
    await app.db.db.insert(outbox).values([
      {
        organizationId: orgId,
        topic: 'notify.rooms',
        payload: {},
        createdAt: at(DAY),
        nextAttemptAt: at(DAY),
        processedAt: at(DAY),
      },
      {
        organizationId: orgId,
        topic: 'notify.rooms',
        payload: {},
        createdAt: at(DAY),
        nextAttemptAt: at(DAY),
        processedAt: at(DAY - 1),
      },
      // Bajarilmagan qator eski bo'lsa ham o'chirilmaydi.
      { organizationId: orgId, topic: 'notify.rooms', payload: {}, createdAt: at(9 * DAY), nextAttemptAt: at(9 * DAY) },
    ]);
    await app.db.db.insert(events).values([
      { organizationId: orgId, siteId, roomId, type: 'lesson.started', data: {}, at: at(7 * DAY) },
      { organizationId: orgId, siteId, roomId, type: 'lesson.started', data: {}, at: at(7 * DAY - 1) },
    ]);
    expect((await worker.tick(now)).purged).toBe(3);
    expect((await app.db.db.select().from(idempotencyKeys)).map((k) => k.key)).toEqual(['new-key-1']);
    expect(await app.db.db.select().from(outbox)).toHaveLength(2);
    expect(await app.db.db.select().from(events)).toHaveLength(1);
  });

  test('hot maintenance queries are indexed', async () => {
    const result = (await app.db.db.execute(
      sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    )) as unknown as { rows: { indexname: string; indexdef: string }[] };
    const byName = new Map(result.rows.map((r) => [r.indexname, r.indexdef]));
    for (const name of [
      'command_targets_open',
      'commands_expires_at',
      'events_at',
      'outbox_processed_at',
      'idempotency_keys_created_at',
      'remote_sessions_open_expires',
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    // Parked qatorlar due indeksidan chiqadi.
    expect(byName.get('outbox_due')).toMatch(/attempts/);
  });

  test('purge runs at most once a minute', async () => {
    await worker.tick(now);
    const [user] = await app.db.db.select().from(users);
    if (!user) throw new Error('user');
    await app.db.db.insert(idempotencyKeys).values({
      actorUserId: user.id,
      scope: 's',
      key: 'old-key-2',
      requestHash: 'h',
      createdAt: new Date(now - 2 * DAY),
    });
    expect((await worker.tick(now + 30_000)).purged).toBe(0);
    expect((await worker.tick(now + 60_000)).purged).toBe(1);
  });
});
