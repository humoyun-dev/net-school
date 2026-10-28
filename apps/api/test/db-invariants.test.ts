import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateDb } from '../src/db/migrate.ts';
import {
  auditEvents,
  devices,
  enrollments,
  meshBindings,
  organizations,
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

  function binding(d: { id: string; organizationId: string; siteId: string }, node: string, siteId = d.siteId) {
    return t.db.insert(meshBindings).values({
      deviceId: d.id,
      organizationId: d.organizationId,
      siteId,
      meshInstanceId: 'local',
      meshDomainId: '',
      meshNodeId: node,
      boundBy: d.id,
    });
  }

  test('mesh node binds to one device', async () => {
    const s = await twoSites();
    const d1 = await device(s.orgId, s.siteId);
    const d2 = await device(s.orgId, s.siteId);
    await binding(d1, 'node-1');
    await rejects(binding(d2, 'node-1'));
    await rejects(binding(d1, 'node-2'));
    await expect(binding(d2, 'node-2')).resolves.toBeDefined();
  });

  test('binding site must match device site', async () => {
    const s = await twoSites();
    const d = await device(s.orgId, s.siteId);
    await rejects(binding(d, 'node-1', s.site2Id));
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
