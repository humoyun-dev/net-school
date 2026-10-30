import { remoteSessionSchema, remoteTicketSchema } from '@netschool/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Db } from '../src/db/client.ts';
import {
  auditEvents,
  controlLeases,
  devices,
  events,
  idempotencyKeys,
  meshBindings,
  outbox,
  remoteSessions,
  sites,
} from '../src/db/schema.ts';
import { AuditWriter } from '../src/modules/audit/audit.writer.ts';
import { EventLog, Outbox } from '../src/modules/events/event-log.ts';
import { closeRemoteSessions } from '../src/modules/remote-sessions/closing.ts';
import { RemoteGateway } from '../src/modules/remote-sessions/remote-gateway.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities } from './support/caps.ts';
import { makeDeviceKey, seedDevice } from './support/device.ts';
import { idem, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { FakeMesh } from './support/mesh.ts';
import { FakeRemote, seedBinding } from './support/remote.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

// Har test yangi soatda: login cheklovi oynasi testlar orasida to'lib qolmaydi.
let start = 1_800_000_000_000;
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

// MeshCentral'da bog'langan qurilma; online — agent ulangan.
async function device(opts: { room?: string; online?: boolean; bind?: boolean; listed?: boolean } = {}) {
  const id = await seedDevice(app.db.db, orgId, siteId, makeDeviceKey().publicKey, { roomId: opts.room ?? roomId });
  const meshNodeId = `node-${id}`;
  if (opts.listed !== false) mesh.nodes.set(meshNodeId, { domain: 'dom-a', name: 'pc', online: opts.online ?? true });
  if (opts.bind !== false)
    await seedBinding(app.db.db, { orgId, siteId, deviceId: id, meshDomainId: 'dom-a', meshNodeId, boundBy: adminId });
  return id;
}
const lessonIn = async (room = roomId, cookie = teacher) => (await startLesson(app, cookie, room)).json;
const open = (cookie: string, lessonId: string, body: unknown, key = idem()) =>
  app.request('POST', `/api/v1/lessons/${lessonId}/remote-sessions`, { body, cookie, headers: key });
const ticket = (cookie: string, sessionId: string) =>
  app.request('POST', `/api/v1/remote-sessions/${sessionId}/ticket`, { cookie });
const read = (cookie: string, sessionId: string) =>
  app.request('GET', `/api/v1/remote-sessions/${sessionId}`, { cookie });
const deps = () => ({
  events: app.get<EventLog>(EventLog),
  outbox: app.get<Outbox>(Outbox),
  audit: app.get<AuditWriter>(AuditWriter),
});
const close = (db: Db, filter: Parameters<typeof closeRemoteSessions>[1], reason: 'teacher' | 'lesson_ended') =>
  db.transaction((tx) => closeRemoteSessions(tx, filter, reason, new Date(now), null, null, deps()));
const denied = (action: string) =>
  app.db.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.result, 'denied')));

describe('opening remote sessions', () => {
  test('teacher opens a view session on a lesson device', async () => {
    const d = await device();
    await setCapabilities(app.db.db, orgId, d, { 'remote.desktop': { state: 'available' } });
    const lesson = await lessonIn();
    const res = await open(teacher, lesson.id, { deviceId: d, mode: 'view' });
    expect(res.status).toBe(201);
    expect(() => remoteSessionSchema.parse(res.json)).not.toThrow();
    expect(res.json).toMatchObject({
      lessonId: lesson.id,
      deviceId: d,
      actorUserId: teacherId,
      mode: 'view',
      status: 'active',
      openedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
      closedAt: null,
      closeReason: null,
      lease: null,
    });
    // Principal shu sessiya uchun, bog'langan node bilan.
    expect(remote.opened).toEqual([
      {
        sessionId: res.json.id,
        actorId: teacherId,
        device: { meshInstanceId: 'local', meshDomainId: 'dom-a', meshNodeId: `node-${d}` },
        mode: 'view',
      },
    ]);
    expect(app.get<RemoteGateway>(RemoteGateway).isOpen(res.json.id)).toBe(true);
    const [row] = await app.db.db.select().from(remoteSessions);
    expect(row).toMatchObject({ organizationId: orgId, siteId, roomId, lessonId: lesson.id });

    const [opened] = await app.db.db.select().from(events).where(eq(events.type, 'remote_session.opened'));
    expect(opened).toMatchObject({ roomId, lessonId: lesson.id });
    expect(opened?.data).toEqual({ sessionId: res.json.id, deviceId: d, mode: 'view' });
    const [audit] = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'remote_session.open'));
    expect(audit).toMatchObject({ actorUserId: teacherId, targetType: 'remote_session', targetId: res.json.id });
    expect(audit?.details).toEqual({ mode: 'view', deviceId: d });

    const got = await read(teacher, res.json.id);
    expect(got.status).toBe(200);
    expect(got.json).toEqual(res.json);
  });

  test('control session holds a lease with a fencing token', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const res = await open(teacher, lesson.id, { deviceId: d, mode: 'control' });
    expect(res.status).toBe(201);
    expect(res.json.lease).toEqual({
      fencing: expect.stringMatching(/^\d+$/),
      expiresAt: new Date(now + 30_000).toISOString(),
    });
    const [lease] = await app.db.db.select().from(controlLeases);
    expect(lease).toMatchObject({ deviceId: d, organizationId: orgId, sessionId: res.json.id });
    expect(String(lease?.fencing)).toBe(res.json.lease.fencing);
    expect(remote.opened[0]?.mode).toBe('control');
  });

  test('devices outside the lesson are denied', async () => {
    const inLesson = await device();
    const elsewhere = await device({ room: otherRoomId });
    const retired = await device();
    const lesson = await lessonIn();
    await app.db.db
      .update(devices)
      .set({ retiredAt: new Date(now) })
      .where(eq(devices.id, retired));

    expect((await open(teacher, lesson.id, { deviceId: elsewhere, mode: 'view' })).status).toBe(403);
    expect((await open(teacher, lesson.id, { deviceId: retired, mode: 'view' })).status).toBe(403);
    // Xonada bo'lsa ham boshqa teacher darsida sessiya ochilmaydi.
    expect((await open(teacher2, lesson.id, { deviceId: inLesson, mode: 'view' })).status).toBe(403);
    expect((await open(teacher2, lesson.id, { deviceId: inLesson, mode: 'control' })).status).toBe(403);
    // Noma'lum dars — bir xil 403.
    expect((await open(teacher, 'not-a-uuid', { deviceId: inLesson, mode: 'view' })).status).toBe(403);
    expect(await denied('remote.view')).toHaveLength(4);
    expect(await denied('remote.control')).toHaveLength(1);
    expect(await app.db.db.select().from(remoteSessions)).toHaveLength(0);
    expect(remote.opened).toHaveLength(0);
  });

  test('ended lesson conflicts', async () => {
    const d = await device();
    const lesson = await lessonIn();
    await app.request('POST', `/api/v1/lessons/${lesson.id}/end`, { body: {}, cookie: teacher, headers: idem() });
    const res = await open(teacher, lesson.id, { deviceId: d, mode: 'view' });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    expect(remote.opened).toHaveLength(0);
  });

  test('unbound or unconfigured devices are capability_unavailable', async () => {
    const unbound = await device({ bind: false });
    const bound = await device();
    const lesson = await lessonIn();
    const expectUnavailable = async (target: TestApp, deviceId: string) => {
      const res = await target.request('POST', `/api/v1/lessons/${lesson.id}/remote-sessions`, {
        body: { deviceId, mode: 'view' },
        cookie: teacher,
        headers: idem(),
      });
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('capability_unavailable');
    };
    await expectUnavailable(app, unbound);

    // Gateway o'chiq (MeshCentral upstream yo'q).
    const noGateway = await startTestApp({ db: app.db, now: () => now, deviceManagement: mesh.factory });
    // Adapter yo'q (placeholder config.mesh bo'lsa ham).
    const noAdapter = await startTestApp({ db: app.db, now: () => now, remote: remote.upstream });
    try {
      await expectUnavailable(noGateway, bound);
      await expectUnavailable(noAdapter, bound);
    } finally {
      await noGateway.close();
      await noAdapter.close();
    }
    // Site MeshCentral domain'iga bog'lanmagan.
    await app.db.db.delete(meshBindings).where(eq(meshBindings.deviceId, bound));
    await app.db.db.update(sites).set({ meshDomainId: null }).where(eq(sites.id, siteId));
    await expectUnavailable(app, bound);

    expect(await app.db.db.select().from(remoteSessions)).toHaveLength(0);
    expect(remote.opened).toHaveLength(0);
  });

  test('reported unavailable remote desktop is capability_unavailable', async () => {
    const d = await device();
    await setCapabilities(app.db.db, orgId, d, { 'remote.desktop': { state: 'requires_permission' } });
    const lesson = await lessonIn();
    const res = await open(teacher, lesson.id, { deviceId: d, mode: 'control' });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('capability_unavailable');
    // Hisobotda kalit yo'q — MeshAgent manba, ruxsat.
    await setCapabilities(app.db.db, orgId, d, { 'classroom.message': { state: 'available' } });
    expect((await open(teacher, lesson.id, { deviceId: d, mode: 'control' })).status).toBe(201);
  });

  test('offline agent is device_offline', async () => {
    const offline = await device({ online: false });
    const missing = await device({ listed: false });
    const lesson = await lessonIn();
    for (const deviceId of [offline, missing]) {
      const res = await open(teacher, lesson.id, { deviceId, mode: 'view' });
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe('device_offline');
    }
    mesh.failing = true;
    const down = await open(teacher, lesson.id, { deviceId: offline, mode: 'view' });
    expect(down.status).toBe(503);
    expect(down.json.error.code).toBe('upstream_unavailable');
    expect(await app.db.db.select().from(remoteSessions)).toHaveLength(0);
    expect(remote.opened).toHaveLength(0);
  });

  test('second controller gets control_busy', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const first = await open(teacher, lesson.id, { deviceId: d, mode: 'control' });
    expect(first.status).toBe(201);
    for (const cookie of [teacher, admin]) {
      const busy = await open(cookie, lesson.id, { deviceId: d, mode: 'control' });
      expect(busy.status).toBe(409);
      expect(busy.json.error.code).toBe('control_busy');
    }
    expect(await app.db.db.select().from(remoteSessions)).toHaveLength(1);
    expect(remote.opened).toHaveLength(1);
    // View lease talab qilmaydi.
    const view = await open(admin, lesson.id, { deviceId: d, mode: 'view' });
    expect(view.status).toBe(201);
    expect(view.json.status).toBe('active');
    const [lease] = await app.db.db.select().from(controlLeases);
    expect(lease?.sessionId).toBe(first.json.id);
  });

  test('expired lease can be taken', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const first = await open(teacher, lesson.id, { deviceId: d, mode: 'control' });
    now = start + 29_999;
    expect((await open(admin, lesson.id, { deviceId: d, mode: 'control' })).json.error.code).toBe('control_busy');
    now = start + 30_001;
    const second = await open(admin, lesson.id, { deviceId: d, mode: 'control' });
    expect(second.status).toBe(201);
    expect(BigInt(second.json.lease.fencing)).toBeGreaterThan(BigInt(first.json.lease.fencing));
    const leases = await app.db.db.select().from(controlLeases);
    expect(leases).toEqual([expect.objectContaining({ sessionId: second.json.id, deviceId: d })]);
    expect((await read(teacher, first.json.id)).json.lease).toBeNull();
  });

  test('upstream failure releases the lease', async () => {
    const d = await device();
    const lesson = await lessonIn();
    remote.failing = true;
    const res = await open(teacher, lesson.id, { deviceId: d, mode: 'control' });
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('upstream_unavailable');
    const [row] = await app.db.db.select().from(remoteSessions);
    expect(row).toMatchObject({ status: 'closed', closeReason: 'upstream_failed', closedBy: null });
    expect(await app.db.db.select().from(controlLeases)).toHaveLength(0);
    const revoke = await app.db.db.select().from(outbox).where(eq(outbox.topic, 'remote.revoke'));
    expect(revoke.map((r) => r.payload)).toEqual([{ sessionId: row?.id }]);

    remote.failing = false;
    const next = await open(admin, lesson.id, { deviceId: d, mode: 'control' });
    expect(next.status).toBe(201);
    expect(next.json.lease).not.toBeNull();
  });

  test('lesson ending during open revokes the fresh principal', async () => {
    const d = await device();
    const lesson = await lessonIn();
    remote.onOpen = async () => {
      await close(app.db.db, { lessonId: lesson.id }, 'lesson_ended');
    };
    const res = await open(teacher, lesson.id, { deviceId: d, mode: 'control' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: 'closed', closeReason: 'lesson_ended', lease: null });
    expect(remote.sessions.get(res.json.id)?.revokeCalls).toBe(1);
    expect(app.get<RemoteGateway>(RemoteGateway).isOpen(res.json.id)).toBe(false);
    // Ochilish hech qachon faol bo'lmagan: open auditi va eventi yo'q.
    expect(await app.db.db.select().from(events).where(eq(events.type, 'remote_session.opened'))).toHaveLength(0);
    const t = await ticket(teacher, res.json.id);
    expect(t.status).toBe(409);
    expect(t.json.error.code).toBe('conflict');
  });

  test('retried open creates one session and never stores a ticket', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const key = idem();
    const first = await open(teacher, lesson.id, { deviceId: d, mode: 'control' }, key);
    expect(first.status).toBe(201);
    const issued = await ticket(teacher, first.json.id);
    expect(issued.status).toBe(200);
    const again = await open(teacher, lesson.id, { deviceId: d, mode: 'control' }, key);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
    expect(await app.db.db.select().from(remoteSessions)).toHaveLength(1);
    expect(remote.opened).toHaveLength(1);

    // Replay joriy holatni qaytaradi (saqlangan javob emas).
    await close(app.db.db, { sessionId: first.json.id }, 'teacher');
    const after = await open(teacher, lesson.id, { deviceId: d, mode: 'control' }, key);
    expect(after.json).toMatchObject({ id: first.json.id, status: 'closed', closeReason: 'teacher' });

    const ticketValue = new URL(issued.json.url).searchParams.get('ticket') ?? '';
    const dump = JSON.stringify([
      await app.db.db.select().from(idempotencyKeys),
      await app.db.db.select().from(auditEvents),
      await app.db.db.select().from(events),
      await app.db.db.select().from(outbox),
    ]);
    expect(ticketValue).toHaveLength(43);
    expect(dump).not.toContain(ticketValue);
    expect(dump).not.toContain('/rs/redeem');
    expect(dump).not.toContain('"ticket"');
  });

  test('ticket is issued only to the session owner', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(teacher, lesson.id, { deviceId: d, mode: 'view' })).json;

    const res = await ticket(teacher, s.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(() => remoteTicketSchema.parse(res.json)).not.toThrow();
    expect(res.json.url).toMatch(/^https:\/\/localhost:8444\/rs\/redeem\?ticket=[A-Za-z0-9_-]{43}$/);
    expect(res.json.expiresAt).toBe(new Date(now + 30_000).toISOString());

    // Admin sessiyani ko'radi (remote.manage), lekin ticket ololmaydi; boshqa teacher hech birini.
    expect((await ticket(admin, s.id)).status).toBe(403);
    expect((await ticket(teacher2, s.id)).status).toBe(403);
    expect((await ticket(teacher, '00000000-0000-4000-8000-000000000000')).status).toBe(403);
    expect((await read(admin, s.id)).status).toBe(200);
    expect((await read(teacher2, s.id)).status).toBe(403);
    expect((await read(teacher, 'nope')).status).toBe(403);
    expect(await denied('remote.view')).toHaveLength(3);
    expect(await denied('remote.manage')).toHaveLength(2);
  });

  test('ticket for a closed session conflicts', async () => {
    const d = await device();
    const lesson = await lessonIn();
    const s = (await open(teacher, lesson.id, { deviceId: d, mode: 'control' })).json;
    const closed = await close(app.db.db, { sessionId: s.id }, 'teacher');
    expect(closed).toEqual([s.id]);
    // Takroriy yopish hech narsa qilmaydi.
    expect(await close(app.db.db, { lessonId: lesson.id }, 'lesson_ended')).toEqual([]);

    const res = await ticket(teacher, s.id);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    const view = (await read(teacher, s.id)).json;
    expect(view).toMatchObject({ status: 'closed', closeReason: 'teacher', closedAt: new Date(now).toISOString() });
    expect(view.lease).toBeNull();
    expect(await app.db.db.select().from(controlLeases)).toHaveLength(0);
    const [closedEvent] = await app.db.db.select().from(events).where(eq(events.type, 'remote_session.closed'));
    expect(closedEvent?.data).toEqual({ sessionId: s.id, deviceId: d, mode: 'control', reason: 'teacher' });
    const [audit] = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'remote_session.close'));
    expect(audit).toMatchObject({ actorUserId: null, targetType: 'remote_session', targetId: s.id });
    expect(audit?.details).toEqual({ reason: 'teacher' });
    const revoke = await app.db.db.select().from(outbox).where(eq(outbox.topic, 'remote.revoke'));
    expect(revoke.map((r) => r.payload)).toEqual([{ sessionId: s.id }]);
  });
});
