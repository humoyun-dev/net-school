import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { commandTargets, controlLeases, events, lessons, outbox, remoteSessions, sites } from '../src/db/schema.ts';
import { EventLog } from '../src/modules/events/event-log.ts';
import { OutboxWorker } from '../src/modules/workers/outbox.worker.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities, setHeartbeat } from './support/caps.ts';
import { type DeviceKey, deviceRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { idem, issueCommand, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { FakeRemote, seedBinding } from './support/remote.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

// Faqat real PostgreSQL'da (CI: TEST_DATABASE_URL): PGlite bitta ulanishda tranzaksiyalarni ketma-ket bajaradi.
const realPg = Boolean(process.env.TEST_DATABASE_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!realPg)('concurrency on real PostgreSQL', () => {
  let now = 1_800_000_000_000;
  let app: TestApp;
  let orgId: string;
  let siteId: string;
  let roomId: string;
  let teacher: string;
  let device: { id: string; key: DeviceKey };
  const mesh = new FakeMesh();
  const remote = new FakeRemote();

  beforeAll(async () => {
    app = await startTestApp({ now: () => now, deviceManagement: mesh.factory, remote: remote.upstream });
  });
  beforeEach(async () => {
    await app.db.reset();
    ({ orgId, siteId } = await seedOrg(app.db.db));
    roomId = await seedRoom(app.db.db, orgId, siteId, '101');
    const teacherId = await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], {
      roomIds: [roomId],
    });
    teacher = await loginAs(app, 'teacher1');
    const key = makeDeviceKey();
    const id = await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId });
    await setCapabilities(app.db.db, orgId, id, { 'classroom.message': { state: 'available' } });
    await setHeartbeat(app.db.db, id, now);
    device = { id, key };
    // MeshCentral'da bog'langan, agenti online qurilma (remote sessiya darvozasi uchun).
    await app.db.db.update(sites).set({ meshDomainId: 'dom-a' }).where(eq(sites.id, siteId));
    await seedBinding(app.db.db, {
      orgId,
      siteId,
      deviceId: id,
      meshDomainId: 'dom-a',
      meshNodeId: 'node-1',
      boundBy: teacherId,
    });
    mesh.nodes.clear();
    mesh.nodes.set('node-1', { domain: 'dom-a', name: 'pc', online: true });
    remote.reset();
  });
  afterAll(async () => {
    await app?.close();
  });

  test('a later event of a room is never visible before an earlier uncommitted one', async () => {
    const log = app.get<EventLog>(EventLog);
    const event = (type: 'lesson.started' | 'lesson.ended') => ({
      organizationId: orgId,
      siteId,
      roomId,
      lessonId: null,
      type,
      data: {},
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = app.db.db.transaction(async (tx) => {
      await log.append(tx, event('lesson.started'));
      await gate;
    });
    let second: Promise<void> = Promise.resolve();
    let visible: string[];
    try {
      await sleep(100);
      second = app.db.db.transaction((tx) => log.append(tx, event('lesson.ended')));
      await sleep(300);
      visible = (await app.db.db.select().from(events).where(eq(events.roomId, roomId))).map((e) => e.type);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    // Cursor reader hech qachon 'ended'ni 'started'dan oldin ko'rmasligi kerak.
    expect(visible).toEqual([]);
    const ordered = (await app.db.db.select().from(events).where(eq(events.roomId, roomId)).orderBy(events.seq)).map(
      (e) => e.type,
    );
    expect(ordered).toEqual(['lesson.started', 'lesson.ended']);
  });

  test('a pull racing a lesson end does not deliver the cancelled command', async () => {
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const cmd = (await issueCommand(app, teacher, lesson.id, { type: 'message.show', payload: { text: 'x' } })).json;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Dars tugashini taqlid qiluvchi tranzaksiya: target bekor, commit kechiktirilgan.
    const ending = app.db.db.transaction(async (tx) => {
      await tx
        .update(lessons)
        .set({ status: 'ended', endedAt: new Date(now), endReason: 'admin' })
        .where(eq(lessons.id, lesson.id));
      await tx
        .update(commandTargets)
        .set({ status: 'cancelled', updatedAt: new Date(now), finishedAt: new Date(now) })
        .where(eq(commandTargets.commandId, cmd.id));
      await gate;
    });
    now += 1;
    let pulling: ReturnType<typeof deviceRequest> | undefined;
    try {
      await sleep(100);
      pulling = deviceRequest(app, device.key, device.id, 'GET', '/api/v1/device/commands?wait=0', undefined, now);
      await sleep(300);
    } finally {
      release();
      await ending;
    }
    const res = await pulling;
    expect(res?.status).toBe(200);
    expect(res?.json.commands).toEqual([]);
    const sent = (await app.db.db.select().from(events)).filter(
      (e) => e.type === 'command.target_updated' && (e.data as { status: string }).status === 'sent',
    );
    expect(sent).toEqual([]);
  });

  test('outbox handlers run outside the claim transaction', async () => {
    const worker = app.get<OutboxWorker>(OutboxWorker);
    const [row] = await app.db.db
      .insert(outbox)
      .values({
        organizationId: orgId,
        topic: 'test.lock',
        payload: {},
        createdAt: new Date(now),
        nextAttemptAt: new Date(now),
      })
      .returning();
    if (!row) throw new Error('outbox');
    let lockError: unknown;
    // Handler boshqa pool ulanishidan shu qatorni NOWAIT bilan qulflaydi: claim tranzaksiyasi ochiq bo'lsa 55P03.
    worker.register('test.lock', async () => {
      try {
        await app.db.db.transaction((tx) =>
          tx.execute(sql`select id from outbox where id = ${row.id} for update nowait`),
        );
      } catch (err) {
        lockError = err;
        throw err;
      }
    });
    const processed = await worker.tick(now);
    expect(lockError).toBeUndefined();
    expect(processed).toBe(1);
    const [after] = await app.db.db.select().from(outbox).where(eq(outbox.id, row.id));
    expect(after).toMatchObject({ attempts: 1, lastError: null });
    expect(after?.processedAt?.getTime()).toBe(now);
  });

  test('control lease is exclusive under concurrency', async () => {
    const lesson = (await startLesson(app, teacher, roomId)).json;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request('POST', `/api/v1/lessons/${lesson.id}/remote-sessions`, {
          body: { deviceId: device.id, mode: 'control' },
          cookie: teacher,
          headers: idem(),
        }),
      ),
    );
    const statuses = results.map((r) => (r.status === 201 ? 201 : `${r.status}/${r.json.error.code}`)).sort();
    expect(statuses).toEqual([201, '409/control_busy', '409/control_busy', '409/control_busy', '409/control_busy']);
    const winner = results.find((r) => r.status === 201)?.json;
    expect(await app.db.db.select().from(remoteSessions)).toEqual([expect.objectContaining({ id: winner.id })]);
    expect(await app.db.db.select().from(controlLeases)).toEqual([expect.objectContaining({ sessionId: winner.id })]);
    expect(remote.opened.map((o) => o.sessionId)).toEqual([winner.id]);
  });
});
