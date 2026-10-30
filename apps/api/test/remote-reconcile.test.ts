import { randomUUID } from 'node:crypto';
import { AdapterError } from '@netschool/meshcentral-adapter';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditEvents, events, outbox, remoteSessions, sites } from '../src/db/schema.ts';
import { AuditWriter } from '../src/modules/audit/audit.writer.ts';
import { EventLog, Outbox } from '../src/modules/events/event-log.ts';
import { RemoteReconciler } from '../src/modules/remote-sessions/reconciler.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { idem, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { FakeRemote, seedBinding } from './support/remote.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let start = 1_950_000_000_000;
let now = start;
const mesh = new FakeMesh();
const remote = new FakeRemote();
let app: TestApp;
let reconciler: RemoteReconciler;
let orgId: string;
let siteId: string;
let roomId: string;
let adminId: string;
let teacher: string;
let lessonId: string;
let devices: string[];

beforeAll(async () => {
  app = await startTestApp({ now: () => now, deviceManagement: mesh.factory, remote: remote.upstream });
  reconciler = app.get<RemoteReconciler>(RemoteReconciler);
});
beforeEach(async () => {
  start += 3_600_000;
  now = start;
  mesh.nodes.clear();
  remote.reset();
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  await app.db.db.update(sites).set({ meshDomainId: 'dom-a' }).where(eq(sites.id, siteId));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  adminId = await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  teacher = await loginAs(app, 'teacher1');
  devices = [];
  for (let i = 0; i < 3; i++) devices.push(await device());
  lessonId = (await startLesson(app, teacher, roomId)).json.id;
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await app?.close();
});

async function device() {
  const id = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId });
  const meshNodeId = `node-${id}`;
  mesh.nodes.set(meshNodeId, { domain: 'dom-a', name: 'pc', online: true });
  await seedBinding(app.db.db, { orgId, siteId, deviceId: id, meshDomainId: 'dom-a', meshNodeId, boundBy: adminId });
  return id;
}
// Sessiya API orqali ochiladi va MeshCentral'da principal'i bor deb belgilanadi.
async function openSession(deviceId: string): Promise<string> {
  const res = await app.request('POST', `/api/v1/lessons/${lessonId}/remote-sessions`, {
    body: { deviceId, mode: 'view' },
    cookie: teacher,
    headers: idem(),
  });
  expect(res.status).toBe(201);
  const id = (res.json as { id: string }).id;
  remote.addPrincipal(id);
  return id;
}
const row = async (id: string) => (await app.db.db.select().from(remoteSessions).where(eq(remoteSessions.id, id)))[0];
const userIdOf = (sessionId: string) => `user/dom-a/ns-sess-${sessionId}`;

describe('startup reconciliation', () => {
  test('startup closes stale sessions and deletes orphan principals', async () => {
    const [d0, d1, d2] = devices as [string, string, string];
    const a = await openSession(d0);
    const b = await openSession(d1);
    // Allaqachon yopilgan sessiya qayta yopilmaydi (reason o'zgarmaydi).
    const done = await openSession(d2);
    const closedAt = new Date(now - 1_000);
    await app.db.db
      .update(remoteSessions)
      .set({ status: 'closed', closedAt, closeReason: 'teacher' })
      .where(eq(remoteSessions.id, done));
    // DB'da yo'q principal.
    const orphan = randomUUID();
    remote.addPrincipal(orphan);
    expect(remote.principals).toHaveLength(4);

    const kicks = vi.spyOn(app.get<Outbox>(Outbox), 'kick');
    const result = await reconciler.reconcile(now, { startup: true });

    expect(result).toEqual({ closedSessions: 2, deletedPrincipals: 4 });
    expect(remote.principals).toEqual([]);
    expect(remote.revokedPrincipals.sort()).toEqual(
      [userIdOf(a), userIdOf(b), userIdOf(done), userIdOf(orphan)].sort(),
    );
    for (const id of [a, b]) {
      expect(await row(id)).toMatchObject({
        status: 'closed',
        closeReason: 'restart',
        closedBy: null,
        closedAt: new Date(now),
      });
    }
    expect(await row(done)).toMatchObject({ closeReason: 'teacher', closedAt });
    // Voqea, audit (actor null) va revoke outbox qatori, commit'dan keyin kick.
    const closedEvents = await app.db.db.select().from(events).where(eq(events.type, 'remote_session.closed'));
    expect(closedEvents.map((e) => e.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: a, reason: 'restart' }),
        expect.objectContaining({ sessionId: b, reason: 'restart' }),
      ]),
    );
    const audits = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'remote_session.close'), eq(auditEvents.result, 'succeeded')));
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit.actorUserId).toBeNull();
      expect(audit.details).toEqual({ reason: 'restart' });
    }
    const revokes = await app.db.db.select().from(outbox).where(eq(outbox.topic, 'remote.revoke'));
    expect(revokes.map((r) => (r.payload as { sessionId: string }).sessionId).sort()).toEqual([a, b].sort());
    expect(kicks).toHaveBeenCalledTimes(1);
  });

  test('nothing to close does not kick the outbox', async () => {
    const kicks = vi.spyOn(app.get<Outbox>(Outbox), 'kick');
    expect(await reconciler.reconcile(now, { startup: true })).toEqual({ closedSessions: 0, deletedPrincipals: 0 });
    expect(kicks).not.toHaveBeenCalled();
  });

  test('unreachable MeshCentral still closes sessions in the database', async () => {
    const [d0, d1] = devices as [string, string];
    const a = await openSession(d0);
    const b = await openSession(d1);
    remote.listFailure = new AdapterError('upstream_unavailable', 'MeshCentral is not connected');

    const result = await reconciler.reconcile(now, { startup: true });

    expect(result).toEqual({ closedSessions: 2, deletedPrincipals: 0 });
    expect(await row(a)).toMatchObject({ status: 'closed', closeReason: 'restart' });
    expect(await row(b)).toMatchObject({ status: 'closed', closeReason: 'restart' });
    expect(remote.principals).toHaveLength(2);

    // MeshCentral qaytgach keyingi davriy o'tish yopilgan sessiyalarning principal'larini tozalaydi.
    remote.listFailure = undefined;
    expect(await reconciler.reconcile(now + 300_000, { startup: false })).toEqual({
      closedSessions: 0,
      deletedPrincipals: 2,
    });
    expect(remote.principals).toEqual([]);
  });

  test('a failure revoking one principal does not stop the others', async () => {
    const [d0, d1, d2] = devices as [string, string, string];
    const a = await openSession(d0);
    const b = await openSession(d1);
    const c = await openSession(d2);
    remote.revokeFailures.add(userIdOf(b));

    const result = await reconciler.reconcile(now, { startup: true });

    expect(result).toEqual({ closedSessions: 3, deletedPrincipals: 2 });
    expect(remote.revokedPrincipals.sort()).toEqual([userIdOf(a), userIdOf(c)].sort());
    expect(remote.principals.map((p) => p.sessionId)).toEqual([b]);
  });

  test('without MeshCentral only the database part runs', async () => {
    const [d0] = devices as [string];
    const a = await openSession(d0);
    const bare = new RemoteReconciler(
      app.db.db,
      () => now,
      false,
      null,
      app.get<EventLog>(EventLog),
      app.get<Outbox>(Outbox),
      app.get<AuditWriter>(AuditWriter),
    );
    expect(await bare.reconcile(now, { startup: true })).toEqual({ closedSessions: 1, deletedPrincipals: 0 });
    expect(await row(a)).toMatchObject({ status: 'closed', closeReason: 'restart' });
    expect(remote.revokedPrincipals).toEqual([]);
  });
});

describe('periodic reconciliation', () => {
  test('periodic pass keeps principals of active sessions', async () => {
    const [d0, d1] = devices as [string, string];
    const a = await openSession(d0);
    const b = await openSession(d1);
    // opening (aktivatsiya oldidan) ham tirik hisoblanadi.
    await app.db.db.update(remoteSessions).set({ status: 'opening' }).where(eq(remoteSessions.id, b));

    const result = await reconciler.reconcile(now, { startup: false });

    expect(result).toEqual({ closedSessions: 0, deletedPrincipals: 0 });
    expect(remote.principals.map((p) => p.sessionId).sort()).toEqual([a, b].sort());
    expect((await row(a))?.status).toBe('active');
  });

  test('periodic pass deletes principals of closed or unknown sessions', async () => {
    const [d0, d1] = devices as [string, string];
    const live = await openSession(d0);
    const gone = await openSession(d1);
    await app.db.db
      .update(remoteSessions)
      .set({ status: 'closed', closedAt: new Date(now), closeReason: 'teacher' })
      .where(eq(remoteSessions.id, gone));
    const unknown = randomUUID();
    remote.addPrincipal(unknown);
    // UUID bo'lmagan id DB so'rovini buzmaydi va noma'lum hisoblanadi.
    remote.addPrincipal('not-a-uuid');

    const result = await reconciler.reconcile(now, { startup: false });

    expect(result).toEqual({ closedSessions: 0, deletedPrincipals: 3 });
    expect(remote.principals.map((p) => p.sessionId)).toEqual([live]);
    expect(remote.revokedPrincipals.sort()).toEqual([userIdOf(gone), userIdOf(unknown), userIdOf('not-a-uuid')].sort());
    expect((await row(live))?.status).toBe('active');
  });

  test('periodic pass survives an unreachable MeshCentral', async () => {
    const [d0] = devices as [string];
    await openSession(d0);
    remote.listFailure = new AdapterError('upstream_timeout', 'MeshCentral did not answer');
    expect(await reconciler.reconcile(now, { startup: false })).toEqual({ closedSessions: 0, deletedPrincipals: 0 });
  });
});

describe('background schedule', () => {
  test('with workers enabled it reconciles on bootstrap and every five minutes', async () => {
    const [d0, d1] = devices as [string, string];
    const a = await openSession(d0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = new RemoteReconciler(
      app.db.db,
      () => now,
      true,
      remote.upstream,
      app.get<EventLog>(EventLog),
      app.get<Outbox>(Outbox),
      app.get<AuditWriter>(AuditWriter),
    );
    try {
      await worker.onApplicationBootstrap();
      expect(await row(a)).toMatchObject({ status: 'closed', closeReason: 'restart' });
      expect(remote.principals).toEqual([]);

      // Bootstrap'dan keyin ochilgan sessiya startup o'tishida yopilmaydi; yetim principal davriy o'tishda ketadi.
      const b = await openSession(d1);
      const orphan = randomUUID();
      remote.addPrincipal(orphan);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.waitFor(() => expect(remote.revokedPrincipals).toContain(userIdOf(orphan)));
      expect((await row(b))?.status).toBe('active');
      expect(remote.principals.map((p) => p.sessionId)).toEqual([b]);
    } finally {
      worker.onModuleDestroy();
    }
  });

  test('a failed startup listing is retried until MeshCentral answers', async () => {
    const [d0, d1] = devices as [string, string];
    const a = await openSession(d0);
    // main.ts MeshCentral ulanishini kutmaydi: startdagi ro'yxatlash odatda shunday xato bilan tugaydi.
    remote.listFailure = new AdapterError('upstream_unavailable', 'Not connected to MeshCentral');
    const listings = vi.spyOn(remote.upstream, 'listPrincipals');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = new RemoteReconciler(
      app.db.db,
      () => now,
      true,
      remote.upstream,
      app.get<EventLog>(EventLog),
      app.get<Outbox>(Outbox),
      app.get<AuditWriter>(AuditWriter),
    );
    // vi.waitFor soxta taymerlarda vaqtni o'zi siljitadi; bu yerda soxta vaqt faqat qo'lda siljiydi.
    const settle = async (check: () => boolean) => {
      const deadline = performance.now() + 5_000;
      while (!check()) {
        if (performance.now() > deadline) throw new Error('reconciler did not settle');
        await new Promise((r) => setImmediate(r));
      }
    };
    // Keyingi o'tish rejalashtirilgunicha kutiladi, shunda soxta vaqt aniq shu taymerdan hisoblanadi.
    const scheduled = () => settle(() => vi.getTimerCount() === 1);
    // `ms - 1` da o'tish yo'q, `ms` da bor.
    const passAfter = async (ms: number, calls: number) => {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(listings).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      await settle(() => listings.mock.calls.length === calls);
      await scheduled();
    };
    try {
      await worker.onApplicationBootstrap();
      expect(await row(a)).toMatchObject({ status: 'closed', closeReason: 'restart' });
      expect(listings).toHaveBeenCalledTimes(1);
      expect(remote.principals).toHaveLength(1);
      await scheduled();

      // Backoff: 5 s, 10 s, 20 s, 40 s, keyin 60 s chegarasi.
      await passAfter(5_000, 2);
      await passAfter(10_000, 3);
      await passAfter(20_000, 4);
      await passAfter(40_000, 5);
      await passAfter(60_000, 6);
      expect(remote.principals).toHaveLength(1);

      // Kechikkan o'tish startdan keyin ochilgan sessiyaga tegmaydi; startdan oldingi (yopilgan) principal ketadi.
      const b = await openSession(d1);
      remote.listFailure = undefined;
      await passAfter(60_000, 7);
      expect(remote.revokedPrincipals).toEqual([userIdOf(a)]);
      expect(remote.principals.map((p) => p.sessionId)).toEqual([b]);
      expect((await row(b))?.status).toBe('active');

      // Birinchi muvaffaqiyatdan keyin oddiy 5 daqiqalik davr (backoff qayta boshlanmaydi).
      remote.listFailure = new AdapterError('upstream_timeout', 'MeshCentral did not answer');
      await passAfter(5 * 60_000, 8);
      await passAfter(5 * 60_000, 9);
    } finally {
      worker.onModuleDestroy();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  test('with workers disabled bootstrap does nothing', async () => {
    const [d0] = devices as [string];
    const a = await openSession(d0);
    await reconciler.onApplicationBootstrap();
    expect((await row(a))?.status).toBe('active');
    expect(remote.principals).toHaveLength(1);
  });
});
