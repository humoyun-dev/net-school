import { request as httpsRequest } from 'node:https';
import { remoteSessionSchema } from '@netschool/contracts';
import { until } from '@netschool/test-support';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, controlLeases, events, outbox, remoteSessions, sites } from '../src/db/schema.ts';
import { RemoteGateway } from '../src/modules/remote-sessions/remote-gateway.ts';
import { MaintenanceWorker } from '../src/modules/workers/maintenance.worker.ts';
import { OutboxWorker, revokeRemoteSession } from '../src/modules/workers/outbox.worker.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, idem, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { FakeRemote, seedBinding } from './support/remote.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

// Har test yangi soatda: login cheklovi oynasi testlar orasida to'lib qolmaydi.
let start = 1_900_000_000_000;
let now = start;
const mesh = new FakeMesh();
const remote = new FakeRemote();
let app: TestApp;
let orgId: string;
let siteId: string;
let roomId: string;
let otherRoomId: string;
let teacherId: string;
let adminId: string;
let teacher: string;
let teacher2: string;
let admin: string;

beforeAll(async () => {
  app = await startTestApp({ now: () => now, deviceManagement: mesh.factory, remote: remote.upstream });
});
beforeEach(async () => {
  start += 3_600_000;
  now = start;
  mesh.nodes.clear();
  mesh.failing = false;
  remote.reset();
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  await app.db.db.update(sites).set({ meshDomainId: 'dom-a' }).where(eq(sites.id, siteId));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  teacherId = await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [roomId, otherRoomId] });
  adminId = await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  teacher = await loginAs(app, 'teacher1');
  teacher2 = await loginAs(app, 'teacher2');
  admin = await loginAs(app, 'admin1');
});
afterAll(async () => {
  await app?.close();
});

async function device(room = roomId) {
  const id = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId: room });
  const meshNodeId = `node-${id}`;
  mesh.nodes.set(meshNodeId, { domain: 'dom-a', name: 'pc', online: true });
  await seedBinding(app.db.db, { orgId, siteId, deviceId: id, meshDomainId: 'dom-a', meshNodeId, boundBy: adminId });
  return id;
}
const lessonIn = async () => (await startLesson(app, teacher, roomId)).json;
const open = (target: TestApp, cookie: string, lessonId: string, body: unknown) =>
  target.request('POST', `/api/v1/lessons/${lessonId}/remote-sessions`, { body, cookie, headers: idem() });
const renew = (cookie: string, sessionId: string, body: unknown = {}) =>
  app.request('POST', `/api/v1/remote-sessions/${sessionId}/renew`, { body, cookie });
const close = (cookie: string, sessionId: string, target = app) =>
  target.request('DELETE', `/api/v1/remote-sessions/${sessionId}`, { cookie });
const sessionRow = async (id: string) =>
  (await app.db.db.select().from(remoteSessions).where(eq(remoteSessions.id, id)))[0];
const revokeRows = () => app.db.db.select().from(outbox).where(eq(outbox.topic, 'remote.revoke'));
const closeAudits = () =>
  app.db.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, 'remote_session.close'), eq(auditEvents.result, 'succeeded')));
const outboxTick = (at = now) => app.get<OutboxWorker>(OutboxWorker).tick(at);
const gateway = () => app.get<RemoteGateway>(RemoteGateway);
const auditCount = async () => (await app.db.db.select().from(auditEvents)).length;
const ticket = (target: TestApp, cookie: string, sessionId: string) =>
  target.request('POST', `/api/v1/remote-sessions/${sessionId}/ticket`, { cookie });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eventually = async (check: () => Promise<boolean>, ms = 2_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
};
// Gateway listener'iga brauzer kabi redeem: javob holati va o'rnatilgan gateway cookie'si (`name=value`).
function redeem(target: TestApp, port: number, ticketUrl: string, cookie?: string) {
  const { pathname, search } = new URL(ticketUrl);
  return new Promise<{ status: number; cookie: string | undefined }>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        ca: target.ca,
        method: 'GET',
        path: `${pathname}${search}`,
        headers: cookie ? { cookie } : {},
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
// Gateway listener'i bilan alohida ilova (umumiy DB va soxta upstream'lar bilan).
async function withLive(run: (live: TestApp, port: number) => Promise<void>, workers = false) {
  const live = await startTestApp({
    db: app.db,
    now: () => now,
    deviceManagement: mesh.factory,
    remote: remote.upstream,
    workers,
  });
  try {
    const port = await live.get<RemoteGateway>(RemoteGateway).listen(0, '127.0.0.1');
    await run(live, port);
  } finally {
    await live.close();
  }
}

describe('renewing remote sessions', () => {
  test('renew extends the session and the lease', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const control = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    const view = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'view' })).json;

    now = start + 10_000;
    const audited = await auditCount();
    const res = await renew(teacher, control.id, { fencing: control.lease.fencing });
    expect(res.status).toBe(200);
    expect(() => remoteSessionSchema.parse(res.json)).not.toThrow();
    expect(res.json).toMatchObject({
      id: control.id,
      status: 'active',
      expiresAt: new Date(now + 30_000).toISOString(),
      lease: { fencing: control.lease.fencing, expiresAt: new Date(now + 30_000).toISOString() },
    });
    const [lease] = await app.db.db.select().from(controlLeases);
    expect(lease?.expiresAt.getTime()).toBe(now + 30_000);
    expect((await sessionRow(control.id))?.expiresAt.getTime()).toBe(now + 30_000);

    // View sessiyada lease yo'q: fencing e'tiborga olinmaydi.
    const v = await renew(teacher, view.id, { fencing: '1' });
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ expiresAt: new Date(now + 30_000).toISOString(), lease: null });
    expect((await renew(teacher, view.id)).status).toBe(200);
    // Renew audit qilinmaydi.
    expect(await auditCount()).toBe(audited);

    // Control sessiyada fencing majburiy; noto'g'ri tana — validation_failed.
    for (const body of [{}, { fencing: 'abc' }, { fencing: control.lease.fencing, extra: 1 }]) {
      const bad = await renew(teacher, control.id, body);
      expect(bad.status).toBe(400);
      expect(bad.json.error.code).toBe('validation_failed');
    }

    // Faqat egasi: admin ham, boshqa teacher ham, noma'lum id ham — 403.
    expect((await renew(admin, control.id, { fencing: control.lease.fencing })).status).toBe(403);
    expect((await renew(teacher2, view.id)).status).toBe(403);
    expect((await renew(teacher, '00000000-0000-4000-8000-000000000000')).status).toBe(403);
    expect(await app.db.db.select().from(auditEvents).where(eq(auditEvents.result, 'denied'))).toHaveLength(3);
  });

  test('renew with a stale fencing conflicts', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    now = start + 10_000;
    for (const fencing of [String(BigInt(s.lease.fencing) + 1n), '0', '9999999999999999999']) {
      const res = await renew(teacher, s.id, { fencing });
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('conflict');
    }
    // Hech narsa uzaymagan.
    expect((await sessionRow(s.id))?.expiresAt.getTime()).toBe(start + 30_000);
    const [lease] = await app.db.db.select().from(controlLeases);
    expect(lease?.expiresAt.getTime()).toBe(start + 30_000);

    // Lease boshqa controllerga o'tgan: eski egasi o'z fencing'i bilan ham uzaytira olmaydi.
    now = start + 30_001;
    const next = (await open(app, admin, lesson.id, { deviceId: d, mode: 'control' })).json;
    expect(next.status).toBe('active');
    const stale = await renew(teacher, s.id, { fencing: s.lease.fencing });
    expect(stale.status).toBe(409);
    const [taken] = await app.db.db.select().from(controlLeases);
    expect(taken).toMatchObject({ sessionId: next.id, expiresAt: new Date(now + 30_000) });
  });

  test('renew after expiry conflicts', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const control = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    const view = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'view' })).json;
    // Muddat aynan shu lahzada tugaydi: expires_at > now emas.
    now = start + 30_000;
    expect((await renew(teacher, control.id, { fencing: control.lease.fencing })).status).toBe(409);
    expect((await renew(teacher, view.id)).status).toBe(409);
    expect((await sessionRow(control.id))?.expiresAt.getTime()).toBe(start + 30_000);

    // Yopilgan sessiya ham uzaymaydi.
    now = start + 1_000;
    const other = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'view' })).json;
    expect((await close(teacher, other.id)).status).toBe(204);
    const res = await renew(teacher, other.id);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
  });
});

describe('gateway-initiated closes', () => {
  test('renew conflicts when the gateway no longer has the session', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    // Gateway sessiyani unutgan, DB qatori hali faol (masalan F1 hook'i ishlamay qolgan).
    await gateway().close(s.id);
    expect((await sessionRow(s.id))?.status).toBe('active');

    now = start + 10_000;
    const res = await renew(teacher, s.id, { fencing: s.lease.fencing });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    expect((await sessionRow(s.id))?.expiresAt.getTime()).toBe(start + 30_000);
    const [lease] = await app.db.db.select().from(controlLeases);
    expect(lease?.expiresAt.getTime()).toBe(start + 30_000);
  });

  test('a second viewer in the same browser closes the first session', async () => {
    await withLive(async (live, port) => {
      const [d1, d2] = [await device(), await device()];
      const lesson = (await startLesson(live, teacher, roomId)).json;
      const a = (await open(live, teacher, lesson.id, { deviceId: d1, mode: 'control' })).json;
      const b = (await open(live, teacher, lesson.id, { deviceId: d2, mode: 'view' })).json;

      // Bitta brauzer (bitta cookie): avval A, keyin B redeem qilinadi — gateway A'ni almashtiradi.
      const first = await redeem(live, port, (await ticket(live, teacher, a.id)).json.url);
      expect(first.status).toBe(303);
      const second = await redeem(live, port, (await ticket(live, teacher, b.id)).json.url, first.cookie);
      expect(second.status).toBe(303);

      await eventually(async () => (await sessionRow(a.id))?.status === 'closed');
      expect(await sessionRow(a.id)).toMatchObject({ status: 'closed', closeReason: 'superseded', closedBy: null });
      expect((await sessionRow(b.id))?.status).toBe('active');
      expect(await app.db.db.select().from(controlLeases)).toHaveLength(0);
      const [audit] = await closeAudits();
      expect(audit).toMatchObject({ actorUserId: null, targetId: a.id });
      expect(audit?.details).toEqual({ reason: 'superseded' });
      const closedEvents = await app.db.db.select().from(events).where(eq(events.type, 'remote_session.closed'));
      expect(closedEvents.map((e) => e.data)).toEqual([
        { sessionId: a.id, deviceId: d1, mode: 'control', reason: 'superseded' },
      ]);

      // A tugagan: renew va ticket 409, qurilma boshqa controller uchun bo'sh.
      expect((await renew(teacher, a.id, { fencing: a.lease.fencing })).status).toBe(409);
      expect((await ticket(live, teacher, a.id)).status).toBe(409);
      expect((await open(live, admin, lesson.id, { deviceId: d1, mode: 'control' })).status).toBe(201);
    });
  });

  test('a failed attach on redeem closes the session as upstream_failed', async () => {
    await withLive(async (live, port) => {
      const d = await device();
      const lesson = (await startLesson(live, teacher, roomId)).json;
      const s = (await open(live, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
      const upstream = remote.sessions.get(s.id);
      if (!upstream) throw new Error('upstream session');
      upstream.attachError = new Error('login refused');

      expect((await redeem(live, port, (await ticket(live, teacher, s.id)).json.url)).status).toBe(502);
      await eventually(async () => (await sessionRow(s.id))?.status === 'closed');
      expect(await sessionRow(s.id)).toMatchObject({ closeReason: 'upstream_failed', closedBy: null });
      expect(await app.db.db.select().from(controlLeases)).toHaveLength(0);
    });
  });
});

describe('closing remote sessions', () => {
  test('owner closes the session and sockets are closed', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    expect(gateway().isOpen(s.id)).toBe(true);

    const res = await close(teacher, s.id);
    expect(res.status).toBe(204);
    expect(await sessionRow(s.id)).toMatchObject({ status: 'closed', closeReason: 'teacher', closedBy: teacherId });
    expect(await app.db.db.select().from(controlLeases)).toHaveLength(0);
    const [audit] = await closeAudits();
    expect(audit).toMatchObject({ actorUserId: teacherId, targetId: s.id });
    expect(audit?.details).toEqual({ reason: 'teacher' });

    // Soketlar va principal outbox orqali yopiladi.
    expect(remote.sessions.get(s.id)?.revokeCalls).toBe(0);
    await outboxTick();
    expect(remote.sessions.get(s.id)?.revokeCalls).toBe(1);
    expect(gateway().isOpen(s.id)).toBe(false);
    const [revoke] = await revokeRows();
    expect(revoke?.processedAt).not.toBeNull();

    // Takroriy yopish — 204, hech narsa o'zgarmaydi.
    now += 1_000;
    expect((await close(teacher, s.id)).status).toBe(204);
    expect(await closeAudits()).toHaveLength(1);
    expect(await revokeRows()).toHaveLength(1);
    expect((await sessionRow(s.id))?.closedAt?.getTime()).toBe(start);

    // Qurilma darhol bo'sh: boshqa controller lease oladi.
    expect((await open(app, admin, lesson.id, { deviceId: d, mode: 'control' })).status).toBe(201);
  });

  test("admin closes another teacher's session", async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'view' })).json;
    expect((await close(admin, s.id)).status).toBe(204);
    expect(await sessionRow(s.id)).toMatchObject({ status: 'closed', closeReason: 'admin', closedBy: adminId });
    const [audit] = await closeAudits();
    expect(audit).toMatchObject({ actorUserId: adminId, targetId: s.id });
    expect(audit?.details).toEqual({ reason: 'admin' });
  });

  test('other teacher cannot close', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    expect((await close(teacher2, s.id)).status).toBe(403);
    expect((await close(teacher, 'not-a-uuid')).status).toBe(403);
    expect((await close(teacher, '00000000-0000-4000-8000-000000000000')).status).toBe(403);
    const denied = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'remote.manage'), eq(auditEvents.result, 'denied')));
    expect(denied).toHaveLength(3);
    expect(await sessionRow(s.id)).toMatchObject({ status: 'active', closedAt: null });
    expect(await revokeRows()).toHaveLength(0);
  });

  test('ending the lesson closes its remote sessions', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const control = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    const view = (await open(app, admin, lesson.id, { deviceId: d, mode: 'view' })).json;
    expect((await endLesson(app, teacher, lesson.id)).status).toBe(200);
    for (const id of [control.id, view.id]) {
      expect(await sessionRow(id)).toMatchObject({
        status: 'closed',
        closeReason: 'lesson_ended',
        closedBy: teacherId,
      });
    }
    expect(await app.db.db.select().from(controlLeases)).toHaveLength(0);
    // Sessiyalar dars voqeasidan oldin yopiladi (lock tartibi).
    const types = (await app.db.db.select().from(events).orderBy(events.seq)).map((e) => e.type);
    expect(types.slice(-3)).toEqual(['remote_session.closed', 'remote_session.closed', 'lesson.ended']);
    await outboxTick();
    expect(remote.sessions.get(control.id)?.revokeCalls).toBe(1);
    expect(remote.sessions.get(view.id)?.revokeCalls).toBe(1);
  });

  test('moving a device out of the room closes its sessions', async () => {
    const moved = await device();
    const retired = await device();
    const stays = await device();
    const lesson = await lessonIn();
    const a = (await open(app, teacher, lesson.id, { deviceId: moved, mode: 'control' })).json;
    const b = (await open(app, teacher, lesson.id, { deviceId: retired, mode: 'view' })).json;
    const c = (await open(app, teacher, lesson.id, { deviceId: stays, mode: 'view' })).json;

    const res = await app.request('PUT', `/api/v1/devices/${moved}/room`, {
      body: { roomId: otherRoomId },
      cookie: admin,
    });
    expect(res.status).toBe(200);
    expect(await sessionRow(a.id)).toMatchObject({ status: 'closed', closeReason: 'device_left', closedBy: adminId });
    expect(await app.db.db.select().from(controlLeases)).toHaveLength(0);

    expect((await app.request('DELETE', `/api/v1/devices/${retired}`, { cookie: admin })).status).toBe(204);
    expect(await sessionRow(b.id)).toMatchObject({ status: 'closed', closeReason: 'device_left', closedBy: adminId });
    expect((await sessionRow(c.id))?.status).toBe('active');

    await outboxTick();
    expect(remote.sessions.get(a.id)?.revokeCalls).toBe(1);
    expect(remote.sessions.get(b.id)?.revokeCalls).toBe(1);
    expect(remote.sessions.get(c.id)?.revokeCalls).toBe(0);
  });

  test('unrenewed session expires and frees the device', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    const maintenance = app.get<MaintenanceWorker>(MaintenanceWorker);
    expect((await maintenance.tick(start + 30_000 - 1)).expiredSessions).toBe(0);
    expect((await maintenance.tick(start + 30_001)).expiredSessions).toBe(1);
    expect(await sessionRow(s.id)).toMatchObject({ status: 'closed', closeReason: 'lease_expired', closedBy: null });
    expect(await app.db.db.select().from(controlLeases)).toHaveLength(0);
    const [audit] = await closeAudits();
    expect(audit).toMatchObject({ actorUserId: null, targetId: s.id });
    expect(audit?.details).toEqual({ reason: 'lease_expired' });
    expect((await maintenance.tick(start + 30_002)).expiredSessions).toBe(0);

    now = start + 30_001;
    await outboxTick();
    expect(remote.sessions.get(s.id)?.revokeCalls).toBe(1);
    const next = await open(app, admin, lesson.id, { deviceId: d, mode: 'control' });
    expect(next.status).toBe(201);
    expect(next.json.lease).not.toBeNull();
  });

  test('taken-over session is closed by the next maintenance tick', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const old = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    now = start + 30_001;
    const next = (await open(app, admin, lesson.id, { deviceId: d, mode: 'control' })).json;
    // Takeover eski sessiyani o'zi yopmaydi.
    expect((await sessionRow(old.id))?.status).toBe('active');

    expect((await app.get<MaintenanceWorker>(MaintenanceWorker).tick(now)).expiredSessions).toBe(1);
    expect(await sessionRow(old.id)).toMatchObject({ status: 'closed', closeReason: 'lease_expired' });
    expect((await sessionRow(next.id))?.status).toBe('active');
    const leases = await app.db.db.select().from(controlLeases);
    expect(leases).toEqual([expect.objectContaining({ sessionId: next.id, deviceId: d })]);
  });
});

describe('revoking remote sessions', () => {
  test('failed revoke is retried', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'view' })).json;
    const upstream = remote.sessions.get(s.id);
    if (!upstream) throw new Error('upstream session');
    upstream.revokeFailures = 1;
    expect((await close(teacher, s.id)).status).toBe(204);

    await outboxTick();
    expect(upstream.revokeCalls).toBe(1);
    const [failed] = await revokeRows();
    expect(failed).toMatchObject({ processedAt: null, attempts: 1, lastError: 'revoke rejected' });
    // Backoff tugamagan: qayta urinilmaydi.
    expect(await outboxTick(now + 999)).toBe(0);
    expect(upstream.revokeCalls).toBe(1);

    expect(await outboxTick(now + 1_000)).toBe(1);
    expect(upstream.revokeCalls).toBe(2);
    expect(gateway().isOpen(s.id)).toBe(false);
    expect((await revokeRows())[0]).toMatchObject({ attempts: 2, processedAt: new Date(now + 1_000) });
  });

  test('revoke of an unknown or already revoked session succeeds', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'view' })).json;
    await revokeRemoteSession(gateway(), s.id);
    await revokeRemoteSession(gateway(), s.id);
    await revokeRemoteSession(gateway(), '00000000-0000-4000-8000-000000000000');
    expect(remote.sessions.get(s.id)?.revokeCalls).toBe(1);

    // Gateway o'chiq — no-op.
    const off = await startTestApp({ db: app.db, now: () => now });
    try {
      await revokeRemoteSession(off.get<RemoteGateway>(RemoteGateway), s.id);
    } finally {
      await off.close();
    }
  });

  test('a hanging revoke does not delay other sessions', async () => {
    const [d1, d2] = [await device(), await device()];
    const lesson = await lessonIn();
    const first = (await open(app, teacher, lesson.id, { deviceId: d1, mode: 'view' })).json;
    const second = (await open(app, teacher, lesson.id, { deviceId: d2, mode: 'view' })).json;
    const hanging = remote.sessions.get(first.id);
    if (!hanging) throw new Error('upstream session');
    let release!: () => void;
    hanging.revokeHold = new Promise<void>((r) => {
      release = r;
    });
    // Birinchi sessiyaning revoke qatori batch'da oldinroq.
    expect((await close(teacher, first.id)).status).toBe(204);
    expect((await close(teacher, second.id)).status).toBe(204);

    let settled = false;
    const ticking = outboxTick().then((n) => {
      settled = true;
      return n;
    });
    const began = Date.now();
    while (remote.sessions.get(second.id)?.revokeCalls !== 1) {
      if (Date.now() - began > 2_000) throw new Error('second session was not revoked within 2 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(Date.now() - began).toBeLessThanOrEqual(2_000);
    expect(gateway().isOpen(second.id)).toBe(false);
    // Birinchisi hali osilgan: tick barcha boshlangan handler'lar tugashini kutadi.
    expect(hanging.revokeCalls).toBe(1);
    expect(settled).toBe(false);
    release();
    await ticking;
    const rows = await revokeRows();
    expect(rows.every((r) => r.processedAt !== null)).toBe(true);
  });

  test('socket teardown does not wait for a slow earlier revoke', async () => {
    let release: (() => void) | undefined;
    await withLive(async (live) => {
      const gw = live.get<RemoteGateway>(RemoteGateway);
      const [d1, d2] = [await device(), await device()];
      const lesson = (await startLesson(live, teacher, roomId)).json;
      const first = (await open(live, teacher, lesson.id, { deviceId: d1, mode: 'view' })).json;
      const hanging = remote.sessions.get(first.id);
      if (!hanging) throw new Error('upstream session');
      hanging.revokeHold = new Promise<void>((r) => {
        release = r;
      });
      // Birinchi sessiyaning revoke'i ishlayotgan tick ichida osiladi.
      expect((await close(teacher, first.id, live)).status).toBe(204);
      await until(() => hanging.revokeCalls === 1);

      const second = (await open(live, teacher, lesson.id, { deviceId: d2, mode: 'view' })).json;
      expect(gw.isOpen(second.id)).toBe(true);
      const closedAt = Date.now();
      expect((await close(teacher, second.id, live)).status).toBe(204);
      await until(() => !gw.isOpen(second.id), 2_000);
      expect(Date.now() - closedAt).toBeLessThanOrEqual(2_000);
      // Principal revoke esa hali outbox navbatida: osilgan tick tugashini kutadi.
      expect(remote.sessions.get(second.id)?.revokeCalls).toBe(0);

      release?.();
      await until(() => remote.sessions.get(second.id)?.revokeCalls === 1, 2_000);
    }, true);
    release?.();
  });

  test('a hanging revoke fails within its timeout', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(app, teacher, lesson.id, { deviceId: d, mode: 'view' })).json;
    const upstream = remote.sessions.get(s.id);
    if (!upstream) throw new Error('upstream session');
    let release!: () => void;
    upstream.revokeHold = new Promise<void>((r) => {
      release = r;
    });
    const began = Date.now();
    await expect(revokeRemoteSession(gateway(), s.id, 50)).rejects.toThrow(/timed out/);
    expect(Date.now() - began).toBeLessThan(1_000);
    release();
  });

  test('revoke happens within two seconds of closing', async () => {
    const live = await startTestApp({
      db: app.db,
      now: () => now,
      deviceManagement: mesh.factory,
      remote: remote.upstream,
      workers: true,
    });
    try {
      const d = await device();
      const lesson = (await startLesson(live, teacher, roomId)).json;
      const s = (await open(live, teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
      expect(s.status).toBe('active');
      const upstream = remote.sessions.get(s.id);
      if (!upstream) throw new Error('upstream session');

      const closedAt = Date.now();
      expect((await close(teacher, s.id, live)).status).toBe(204);
      while (upstream.revokeCalls === 0) {
        if (Date.now() - closedAt > 2_000) throw new Error('revoke did not happen within 2 s');
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(Date.now() - closedAt).toBeLessThanOrEqual(2_000);
      expect(live.get<RemoteGateway>(RemoteGateway).isOpen(s.id)).toBe(false);
    } finally {
      await live.close();
    }
  });
});
