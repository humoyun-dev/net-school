import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { run } from '../src/cli/run.ts';
import { auditEvents, authSessions, organizations, roleAssignments, sites, users } from '../src/db/schema.ts';
import { verifyPassword } from '../src/modules/identity/password.ts';
import { SessionService } from '../src/modules/identity/sessions.ts';
import { createTestDb, type TestDb } from './support/db.ts';
import { seedOrg, seedUser } from './support/seed.ts';

let t: TestDb;
let out: string[];
const stdout = { write: (s: string) => void out.push(s) };
const cli = (...argv: string[]) => run(argv, { db: t.db, driver: t.driver, stdout });
const printedPassword = () => out.join('').match(/password: (\S+)/)?.[1] ?? '';

beforeAll(async () => {
  t = await createTestDb();
});
beforeEach(async () => {
  out = [];
  await t.reset();
});
afterAll(async () => {
  await t?.close();
});

test('migrate applies migrations and is idempotent', async () => {
  expect(await cli('migrate')).toBe(0);
  expect(await cli('migrate')).toBe(0);
});

test('bootstrap creates org, site and a must-change admin', async () => {
  expect(await cli('bootstrap', '--org', 'Maktab 7', '--site', 'Asosiy bino', '--admin', 'admin')).toBe(0);
  const [org] = await t.db.select().from(organizations);
  const [site] = await t.db.select().from(sites);
  const [admin] = await t.db.select().from(users);
  expect(org?.name).toBe('Maktab 7');
  expect(site).toMatchObject({ name: 'Asosiy bino', organizationId: org?.id });
  expect(admin).toMatchObject({ username: 'admin', mustChangePassword: true, organizationId: org?.id });
  const roles = await t.db.select().from(roleAssignments);
  expect(roles).toEqual([expect.objectContaining({ role: 'school_admin', siteId: null })]);
  const password = printedPassword();
  expect(password).toMatch(/^[A-Za-z0-9_-]{20}$/);
  expect(await verifyPassword(password, admin?.passwordHash ?? '')).toBe(true);
});

test('bootstrap refuses to run twice', async () => {
  expect(await cli('bootstrap', '--org', 'A', '--site', 'S', '--admin', 'admin')).toBe(0);
  out = [];
  expect(await cli('bootstrap', '--org', 'B', '--site', 'S', '--admin', 'admin2')).toBe(2);
  expect(await t.db.select().from(organizations)).toHaveLength(1);
  expect(out.join('')).not.toMatch(/password:/);
});

test('bootstrap rejects an invalid admin username', async () => {
  expect(await cli('bootstrap', '--org', 'A', '--site', 'S', '--admin', 'Bad Name')).toBe(1);
  expect(await t.db.select().from(organizations)).toHaveLength(0);
});

test('reset-password revokes existing sessions', async () => {
  const { orgId, siteId } = await seedOrg(t.db);
  const userId = await seedUser(t.db, orgId, 'teacher1', [{ role: 'teacher', siteId }]);
  const sessions = new SessionService(t.db, { now: Date.now, idleMs: 7_200_000, absoluteMs: 43_200_000 });
  await sessions.create(t.db, userId);
  await sessions.create(t.db, userId);

  expect(await cli('reset-password', 'TEACHER1')).toBe(0);
  expect(await t.db.select().from(authSessions)).toHaveLength(0);
  const [user] = await t.db.select().from(users).where(eq(users.id, userId));
  expect(user?.mustChangePassword).toBe(true);
  expect(await verifyPassword(printedPassword(), user?.passwordHash ?? '')).toBe(true);
});

test('reset-password unlocks a locked account', async () => {
  const { orgId, siteId } = await seedOrg(t.db);
  const userId = await seedUser(t.db, orgId, 'teacher1', [{ role: 'teacher', siteId }]);
  await t.db
    .update(users)
    .set({ failedLoginCount: 10, lockedUntil: new Date(Date.now() + 600_000) })
    .where(eq(users.id, userId));
  expect(await cli('reset-password', 'teacher1')).toBe(0);
  const [user] = await t.db.select().from(users).where(eq(users.id, userId));
  expect(user).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
});

test('reset-password for an unknown user exits 1', async () => {
  expect(await cli('reset-password', 'ghost')).toBe(1);
});

test('cli never writes the password to the audit log', async () => {
  await cli('bootstrap', '--org', 'A', '--site', 'S', '--admin', 'admin');
  const first = printedPassword();
  out = [];
  await cli('reset-password', 'admin');
  const second = printedPassword();
  const audit = await t.db.select().from(auditEvents);
  expect(audit.map((a) => a.action).sort()).toEqual(['auth.password_reset', 'hub.bootstrap']);
  expect(audit.find((a) => a.action === 'auth.password_reset')?.details).toEqual({ via: 'cli' });
  const dump = JSON.stringify(audit);
  expect(dump).not.toContain(first);
  expect(dump).not.toContain(second);
});

test('unknown command prints usage and exits 1', async () => {
  expect(await cli('frobnicate')).toBe(1);
  expect(out.join('')).toMatch(/usage/i);
});
