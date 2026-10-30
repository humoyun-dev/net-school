import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateDb } from '../src/db/migrate.ts';
import {
  auditEvents,
  commands,
  commandTargets,
  controlLeases,
  devices,
  enrollments,
  lessonDevices,
  lessons,
  meshBindings,
  organizations,
  remoteSessions,
  roleAssignments,
  rooms,
  sites,
  users,
} from '../src/db/schema.ts';
import { createTestDb, type TestDb } from './support/db.ts';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => {
  await t.reset();
});
afterAll(async () => {
  await t?.close();
});

async function org(name: string) {
  const [row] = await t.db.insert(organizations).values({ name }).returning();
  if (!row) throw new Error('no org');
  const [site] = await t.db
    .insert(sites)
    .values({ organizationId: row.id, name: `${name}-site` })
    .returning();
  if (!site) throw new Error('no site');
  return { orgId: row.id, siteId: site.id };
}

async function rejects(p: Promise<unknown>) {
  await expect(p).rejects.toThrow();
}

describe('tenant invariants', () => {
  test('room cannot reference a site of another organization', async () => {
    const a = await org('a');
    const b = await org('b');
    await rejects(t.db.insert(rooms).values({ organizationId: a.orgId, siteId: b.siteId, name: 'r' }));
    await expect(
      t.db.insert(rooms).values({ organizationId: a.orgId, siteId: a.siteId, name: 'r' }).returning(),
    ).resolves.toHaveLength(1);
  });

  test('role assignment cannot reference a site of another organization', async () => {
    const a = await org('a');
    const b = await org('b');
    const [u] = await t.db
      .insert(users)
      .values({ organizationId: a.orgId, username: 'teacher1', displayName: 'T', passwordHash: 'x' })
      .returning();
    if (!u) throw new Error('no user');
    await rejects(
      t.db.insert(roleAssignments).values({ organizationId: a.orgId, userId: u.id, role: 'teacher', siteId: b.siteId }),
    );
    await rejects(
      t.db.insert(roleAssignments).values({ organizationId: b.orgId, userId: u.id, role: 'teacher', siteId: b.siteId }),
    );
  });

  test('usernames are unique case-insensitively', async () => {
    const a = await org('a');
    const b = await org('b');
    await t.db.insert(users).values({ organizationId: a.orgId, username: 'ali', displayName: 'A', passwordHash: 'x' });
    await rejects(
      t.db.insert(users).values({ organizationId: b.orgId, username: 'ALI', displayName: 'A', passwordHash: 'x' }),
    );
  });

  test('non-admin role requires a site', async () => {
    const a = await org('a');
    const [u] = await t.db
      .insert(users)
      .values({ organizationId: a.orgId, username: 'u1', displayName: 'U', passwordHash: 'x' })
      .returning();
    if (!u) throw new Error('no user');
    await rejects(t.db.insert(roleAssignments).values({ organizationId: a.orgId, userId: u.id, role: 'teacher' }));
    await expect(
      t.db.insert(roleAssignments).values({ organizationId: a.orgId, userId: u.id, role: 'school_admin' }).returning(),
    ).resolves.toHaveLength(1);
    await rejects(t.db.insert(roleAssignments).values({ organizationId: a.orgId, userId: u.id, role: 'school_admin' }));
    await rejects(
      t.db.execute(
        sql`insert into role_assignments (organization_id, user_id, role, site_id) values (${a.orgId}, ${u.id}, 'superuser', ${a.siteId})`,
      ),
    );
  });

  test('audit event without organization is allowed only for auth actions', async () => {
    await expect(
      t.db.insert(auditEvents).values({ action: 'auth.login', result: 'failed', correlationId: 'c' }).returning(),
    ).resolves.toHaveLength(1);
    await rejects(t.db.insert(auditEvents).values({ action: 'room.create', result: 'succeeded', correlationId: 'c' }));
  });

  test('migrations apply on an empty database twice idempotently', async () => {
    await migrateDb(t.db, t.driver);
    await migrateDb(t.db, t.driver);
    const a = await org('after-migrate');
    expect(a.orgId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('device invariants', () => {
  async function twoSites() {
    const a = await org('a');
    const [site2] = await t.db.insert(sites).values({ organizationId: a.orgId, name: 'a-site-2' }).returning();
    if (!site2) throw new Error('no site');
    const [room1] = await t.db
      .insert(rooms)
      .values({ organizationId: a.orgId, siteId: a.siteId, name: 'r1' })
      .returning();
    const [room2] = await t.db
      .insert(rooms)
      .values({ organizationId: a.orgId, siteId: site2.id, name: 'r2' })
      .returning();
    if (!room1 || !room2) throw new Error('no room');
    return { ...a, site2Id: site2.id, room1Id: room1.id, room2Id: room2.id };
  }

  let fp = 0;
  function device(orgId: string, siteId: string, roomId: string | null = null) {
    fp += 1;
    return t.db
      .insert(devices)
      .values({
        organizationId: orgId,
        siteId,
        roomId,
        hostname: `pc-${fp}`,
        publicKey: Buffer.from(`key-${fp}`),
        keyFingerprint: `fp-${fp}`,
      })
      .returning()
      .then(([row]) => {
        if (!row) throw new Error('no device');
        return row;
      });
  }

  test('device room must belong to device site', async () => {
    const s = await twoSites();
    await rejects(device(s.orgId, s.siteId, s.room2Id));
    await expect(device(s.orgId, s.siteId, s.room1Id)).resolves.toMatchObject({ roomId: s.room1Id });
    await expect(device(s.orgId, s.siteId, null)).resolves.toMatchObject({ roomId: null });
    const [admin] = await t.db
      .insert(users)
      .values({ organizationId: s.orgId, username: 'admin1', displayName: 'A', passwordHash: 'x' })
      .returning();
    if (!admin) throw new Error('no user');
    const enrollment = (roomId: string) =>
      t.db.insert(enrollments).values({
        organizationId: s.orgId,
        siteId: s.siteId,
        roomId,
        tokenHash: Buffer.from(roomId),
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
    await rejects(enrollment(s.room2Id));
    await expect(enrollment(s.room1Id)).resolves.toBeDefined();
  });

  // Binding domain'i site domain'iga teng bo'lishi shart (mesh_bindings_site_domain_fk).
  async function withDomains(s: { siteId: string; site2Id: string }) {
    await t.db.update(sites).set({ meshDomainId: '' }).where(sql`${sites.id} = ${s.siteId}`);
    await t.db.update(sites).set({ meshDomainId: 'b' }).where(sql`${sites.id} = ${s.site2Id}`);
  }

  function binding(
    d: { id: string; organizationId: string; siteId: string },
    node: string,
    siteId = d.siteId,
    meshDomainId = '',
  ) {
    return t.db.insert(meshBindings).values({
      deviceId: d.id,
      organizationId: d.organizationId,
      siteId,
      meshInstanceId: 'local',
      meshDomainId,
      meshNodeId: node,
      boundBy: d.id,
    });
  }

  test('mesh node binds to one device', async () => {
    const s = await twoSites();
    await withDomains(s);
    const d1 = await device(s.orgId, s.siteId);
    const d2 = await device(s.orgId, s.siteId);
    await binding(d1, 'node-1');
    await rejects(binding(d2, 'node-1'));
    await rejects(binding(d1, 'node-2'));
    await expect(binding(d2, 'node-2')).resolves.toBeDefined();
  });

  test('binding site must match device site', async () => {
    const s = await twoSites();
    await withDomains(s);
    const d = await device(s.orgId, s.siteId);
    // Domain site2 bilan mos: rad etilishi faqat qurilma site'i farqidan.
    await rejects(binding(d, 'node-1', s.site2Id, 'b'));
    await expect(binding(d, 'node-1')).resolves.toBeDefined();
  });

  test('binding domain must match its site domain', async () => {
    const s = await twoSites();
    await withDomains(s);
    const d = await device(s.orgId, s.siteId);
    await rejects(binding(d, 'node-1', s.siteId, 'b'));
    await binding(d, 'node-1');
    await rejects(t.db.update(sites).set({ meshDomainId: 'c' }).where(sql`${sites.id} = ${s.siteId}`));
  });

  test('key fingerprint is unique', async () => {
    const s = await twoSites();
    const d = await device(s.orgId, s.siteId);
    await rejects(
      t.db.insert(devices).values({
        organizationId: s.orgId,
        siteId: s.site2Id,
        hostname: 'dup',
        publicKey: Buffer.from('other'),
        keyFingerprint: d.keyFingerprint,
      }),
    );
  });

  test('configured mesh domains are unique but many sites may be unconfigured', async () => {
    const s = await twoSites();
    await t.db.insert(sites).values({ organizationId: s.orgId, name: 'a-site-3' });
    await t.db.update(sites).set({ meshDomainId: '' }).where(sql`${sites.id} = ${s.siteId}`);
    await rejects(t.db.update(sites).set({ meshDomainId: '' }).where(sql`${sites.id} = ${s.site2Id}`));
    await expect(
      t.db.update(sites).set({ meshDomainId: 'b' }).where(sql`${sites.id} = ${s.site2Id}`),
    ).resolves.toBeDefined();
  });

  test('failed device claim may be audited without an organization', async () => {
    await expect(
      t.db.insert(auditEvents).values({ action: 'device.claim', result: 'failed', correlationId: 'c-1' }).returning(),
    ).resolves.toHaveLength(1);
    await rejects(t.db.insert(auditEvents).values({ action: 'device.bind', result: 'failed', correlationId: 'c-2' }));
  });
});

describe('lesson invariants', () => {
  async function setup() {
    const a = await org('a');
    const [site2] = await t.db.insert(sites).values({ organizationId: a.orgId, name: 'a-site-2' }).returning();
    const [room] = await t.db
      .insert(rooms)
      .values({ organizationId: a.orgId, siteId: a.siteId, name: 'r1' })
      .returning();
    const [room2] = await t.db
      .insert(rooms)
      .values({ organizationId: a.orgId, siteId: a.siteId, name: 'r2' })
      .returning();
    const [teacher] = await t.db
      .insert(users)
      .values({ organizationId: a.orgId, username: 'teacher1', displayName: 'T', passwordHash: 'x' })
      .returning();
    if (!site2 || !room || !room2 || !teacher) throw new Error('setup');
    return { ...a, site2Id: site2.id, roomId: room.id, room2Id: room2.id, teacherId: teacher.id };
  }
  type S = Awaited<ReturnType<typeof setup>>;

  const lesson = (s: S, roomId = s.roomId, extra: Partial<typeof lessons.$inferInsert> = {}) =>
    t.db
      .insert(lessons)
      .values({
        organizationId: s.orgId,
        siteId: s.siteId,
        roomId,
        teacherUserId: s.teacherId,
        startedAt: new Date(),
        scheduledEndAt: new Date(Date.now() + 3_600_000),
        ...extra,
      })
      .returning()
      .then(([row]) => {
        if (!row) throw new Error('lesson');
        return row;
      });

  let n = 0;
  const device = async (s: S, siteId = s.siteId) => {
    n += 1;
    const [row] = await t.db
      .insert(devices)
      .values({
        organizationId: s.orgId,
        siteId,
        hostname: `l-pc-${n}`,
        publicKey: Buffer.from(`lk-${n}`),
        keyFingerprint: `lfp-${n}`,
      })
      .returning();
    if (!row) throw new Error('device');
    return row;
  };

  test('one active lesson per room', async () => {
    const s = await setup();
    const first = await lesson(s);
    await rejects(lesson(s));
    await expect(lesson(s, s.room2Id)).resolves.toBeDefined();
    await t.db
      .update(lessons)
      .set({ status: 'ended', endedAt: new Date(), endReason: 'teacher' })
      .where(sql`${lessons.id} = ${first.id}`);
    await expect(lesson(s)).resolves.toBeDefined();
  });

  test('ended lesson must have ended_at', async () => {
    const s = await setup();
    await rejects(lesson(s, s.roomId, { status: 'ended' }));
    await rejects(lesson(s, s.roomId, { endedAt: new Date() }));
    await rejects(lesson(s, s.roomId, { status: 'paused' }));
  });

  test('a device is in one active lesson', async () => {
    const s = await setup();
    const l1 = await lesson(s);
    const l2 = await lesson(s, s.room2Id);
    const d = await device(s);
    const join = (lessonId: string) =>
      t.db.insert(lessonDevices).values({ lessonId, deviceId: d.id, organizationId: s.orgId, siteId: s.siteId });
    await join(l1.id);
    await rejects(join(l2.id));
    await t.db.update(lessonDevices).set({ releasedAt: new Date() }).where(sql`${lessonDevices.lessonId} = ${l1.id}`);
    await expect(join(l2.id)).resolves.toBeDefined();
  });

  test('lesson devices belong to the lesson site', async () => {
    const s = await setup();
    const l = await lesson(s);
    const far = await device(s, s.site2Id);
    await rejects(
      t.db
        .insert(lessonDevices)
        .values({ lessonId: l.id, deviceId: far.id, organizationId: s.orgId, siteId: s.siteId }),
    );
    await rejects(
      t.db
        .insert(lessonDevices)
        .values({ lessonId: l.id, deviceId: far.id, organizationId: s.orgId, siteId: s.site2Id }),
    );
  });

  test('command target status and reason are constrained', async () => {
    const s = await setup();
    const l = await lesson(s);
    const d = await device(s);
    const [cmd] = await t.db
      .insert(commands)
      .values({
        organizationId: s.orgId,
        siteId: s.siteId,
        lessonId: l.id,
        issuedBy: s.teacherId,
        type: 'overlay.lock',
        payload: {},
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!cmd) throw new Error('cmd');
    expect(typeof cmd.seq).toBe('number');
    const target = (status: string, reason: string | null = null) =>
      t.db.insert(commandTargets).values({
        commandId: cmd.id,
        deviceId: d.id,
        organizationId: s.orgId,
        status,
        reason,
        updatedAt: new Date(),
      });
    await rejects(target('done'));
    await rejects(target('failed'));
    await rejects(target('pending', 'unsupported'));
    await rejects(target('failed', 'because'));
    await expect(target('failed', 'unsupported')).resolves.toBeDefined();
    await rejects(
      t.db.insert(commands).values({
        organizationId: s.orgId,
        siteId: s.siteId,
        lessonId: l.id,
        issuedBy: s.teacherId,
        type: 'shell.run',
        payload: {},
        issuedAt: new Date(),
        expiresAt: new Date(),
      }),
    );
  });

  const session = (
    s: S,
    l: { id: string },
    d: { id: string },
    extra: Partial<typeof remoteSessions.$inferInsert> = {},
  ) =>
    t.db
      .insert(remoteSessions)
      .values({
        organizationId: s.orgId,
        siteId: s.siteId,
        roomId: s.roomId,
        lessonId: l.id,
        deviceId: d.id,
        actorUserId: s.teacherId,
        mode: 'control',
        status: 'active',
        openedAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
        ...extra,
      })
      .returning()
      .then(([row]) => {
        if (!row) throw new Error('session');
        return row;
      });

  const nextFencing = async () => {
    const res = (await t.db.execute(sql`select nextval('control_fencing_seq')::text as v`)) as unknown as {
      rows: { v: string }[];
    };
    return BigInt(res.rows[0]?.v ?? '');
  };

  test('a device has at most one control lease', async () => {
    const s = await setup();
    const l = await lesson(s);
    const d = await device(s);
    const first = await session(s, l, d);
    const second = await session(s, l, d, { mode: 'view' });
    const lease = (sessionId: string) =>
      t.db.insert(controlLeases).values({
        deviceId: d.id,
        organizationId: s.orgId,
        sessionId,
        fencing: 1,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      });
    await lease(first.id);
    await rejects(lease(second.id));
    // Bitta sessiya ikkita qurilmada lease ushlay olmaydi.
    const other = await device(s);
    await rejects(
      t.db.insert(controlLeases).values({
        deviceId: other.id,
        organizationId: s.orgId,
        sessionId: first.id,
        fencing: 2,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      }),
    );
  });

  test("a lease belongs to its session's device", async () => {
    const s = await setup();
    const l = await lesson(s);
    const d = await device(s);
    const other = await device(s);
    const sess = await session(s, l, d);
    const lease = (deviceId: string, organizationId = s.orgId) =>
      t.db.insert(controlLeases).values({
        deviceId,
        organizationId,
        sessionId: sess.id,
        fencing: 1,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      });
    await rejects(lease(other.id));
    // Tashkilot qurilmaning tashkilotiga mos bo'lishi shart.
    const foreign = await org('foreign-org');
    await rejects(lease(d.id, foreign.orgId));
    await expect(lease(d.id)).resolves.toBeDefined();
  });

  test('remote session mode, status and reason are constrained', async () => {
    const s = await setup();
    const l = await lesson(s);
    const d = await device(s);
    await rejects(session(s, l, d, { mode: 'shell' }));
    await rejects(session(s, l, d, { status: 'paused' }));
    await rejects(
      session(s, l, d, { status: 'closed', closedAt: new Date(), closeReason: 'because', closedBy: s.teacherId }),
    );
    for (const reason of [
      'teacher',
      'admin',
      'lesson_ended',
      'device_left',
      'lease_expired',
      'upstream_failed',
      'restart',
    ]) {
      await expect(
        session(s, l, d, { status: 'closed', closedAt: new Date(), closeReason: reason }),
      ).resolves.toBeDefined();
    }
    for (const mode of ['view', 'control']) {
      for (const status of ['opening', 'active']) {
        await expect(session(s, l, d, { mode, status })).resolves.toBeDefined();
      }
    }
  });

  test('closed session must have closed_at and reason', async () => {
    const s = await setup();
    const l = await lesson(s);
    const d = await device(s);
    await rejects(session(s, l, d, { status: 'closed' }));
    await rejects(session(s, l, d, { status: 'closed', closedAt: new Date() }));
    await rejects(session(s, l, d, { status: 'closed', closeReason: 'teacher' }));
    await rejects(session(s, l, d, { status: 'active', closedAt: new Date() }));
    await rejects(session(s, l, d, { status: 'opening', closeReason: 'teacher' }));
    await expect(
      session(s, l, d, { status: 'closed', closedAt: new Date(), closeReason: 'teacher' }),
    ).resolves.toBeDefined();
    const open = await session(s, l, d);
    await rejects(t.db.update(remoteSessions).set({ status: 'closed' }).where(sql`${remoteSessions.id} = ${open.id}`));
    await expect(
      t.db
        .update(remoteSessions)
        .set({ status: 'closed', closedAt: new Date(), closeReason: 'device_left' })
        .where(sql`${remoteSessions.id} = ${open.id}`),
    ).resolves.toBeDefined();
  });

  test('remote session device belongs to the lesson site', async () => {
    const s = await setup();
    const l = await lesson(s);
    const far = await device(s, s.site2Id);
    await rejects(session(s, l, far));
    await rejects(session(s, l, far, { siteId: s.site2Id }));
    // Xona ham dars site'iga tegishli bo'lishi shart.
    const [foreignRoom] = await t.db
      .insert(rooms)
      .values({ organizationId: s.orgId, siteId: s.site2Id, name: 'far-room' })
      .returning();
    if (!foreignRoom) throw new Error('room');
    const here = await device(s);
    await rejects(session(s, l, here, { roomId: foreignRoom.id }));
    const near = await device(s);
    await expect(session(s, l, near)).resolves.toBeDefined();
    // Boshqa tashkilot foydalanuvchisi actor bo'la olmaydi.
    const other = await org('other');
    const [stranger] = await t.db
      .insert(users)
      .values({ organizationId: other.orgId, username: 'stranger', displayName: 'S', passwordHash: 'x' })
      .returning();
    if (!stranger) throw new Error('user');
    await rejects(session(s, l, near, { actorUserId: stranger.id }));
  });

  test('fencing values increase', async () => {
    const a = await nextFencing();
    const b = await nextFencing();
    const c = await nextFencing();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    const s = await setup();
    const l = await lesson(s);
    const d = await device(s);
    const sess = await session(s, l, d);
    await expect(
      t.db.execute(sql`insert into control_leases (device_id, organization_id, session_id, fencing, acquired_at, expires_at)
        values (${d.id}, ${s.orgId}, ${sess.id}, nextval('control_fencing_seq'), now(), now() + interval '30 seconds')`),
    ).resolves.toBeDefined();
  });
});
