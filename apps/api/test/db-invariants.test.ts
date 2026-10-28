import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateDb } from '../src/db/migrate.ts';
import { auditEvents, organizations, roleAssignments, rooms, sites, users } from '../src/db/schema.ts';
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
