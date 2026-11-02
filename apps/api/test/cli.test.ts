import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const agents = {
  groups: [] as string[],
  downloads: [] as { meshid: string; arch: string }[],
  async installer(groupName: string, arch: 'x64' | 'arm64') {
    this.groups.push(groupName);
    this.downloads.push({ meshid: 'mesh//g1', arch });
    return { meshid: 'mesh//g1', bytes: Buffer.from(`MZ agent ${arch}`) };
  },
};
const cli = (...argv: string[]) => run(argv, { db: t.db, driver: t.driver, stdout, meshAgents: agents });
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

test('reset-password re-enables a disabled user', async () => {
  const { orgId, siteId } = await seedOrg(t.db);
  const userId = await seedUser(t.db, orgId, 'teacher1', [{ role: 'teacher', siteId }]);
  await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
  expect(await cli('reset-password', 'teacher1')).toBe(0);
  const [user] = await t.db.select().from(users).where(eq(users.id, userId));
  expect(user?.disabledAt).toBeNull();
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

test('mesh-agent-installer writes the installer for the site group and links the site to the default domain', async () => {
  const { orgId } = await seedOrg(t.db);
  const out = join(mkdtempSync(join(tmpdir(), 'agent-')), 'agent.exe');
  agents.groups.length = 0;
  expect(await cli('mesh-agent-installer', '--site', 'Maktab 1 bino A', '--arch', 'arm64', '--out', out)).toBe(0);
  expect(readFileSync(out).toString()).toBe('MZ agent arm64');
  expect(agents.groups).toEqual(['NetSchool — Maktab 1 bino A']);
  const [site] = await t.db.select().from(sites).where(eq(sites.name, 'Maktab 1 bino A'));
  expect(site?.meshDomainId).toBe('');
  const audits = await t.db.select().from(auditEvents).where(eq(auditEvents.organizationId, orgId));
  expect(audits.map((a) => a.action)).toContain('mesh.agent_installer');
});

test('mesh-agent-installer: unknown site or bad arch exits 1', async () => {
  await seedOrg(t.db);
  expect(await cli('mesh-agent-installer', '--site', "Yo'q", '--arch', 'x64', '--out', '/tmp/x.exe')).toBe(1);
  expect(await cli('mesh-agent-installer', '--site', 'Maktab 1 bino A', '--arch', 'ia64', '--out', '/tmp/x.exe')).toBe(
    1,
  );
});

test('mesh-agent-installer without MeshCentral exits 2 and explains the agent cache', async () => {
  await seedOrg(t.db);
  const code = await run(
    ['mesh-agent-installer', '--site', 'Maktab 1 bino A', '--arch', 'x64', '--out', '/tmp/x.exe'],
    {
      db: t.db,
      driver: t.driver,
      stdout,
      meshAgents: null,
    },
  );
  expect(code).toBe(2);
  expect(out.join('')).toMatch(/MESHCENTRAL_URL/);
  const failing = {
    installer: async () => {
      throw new Error('HTTP 404');
    },
  };
  out = [];
  expect(
    await run(['mesh-agent-installer', '--site', 'Maktab 1 bino A', '--arch', 'x64', '--out', '/tmp/x.exe'], {
      db: t.db,
      driver: t.driver,
      stdout,
      meshAgents: failing,
    }),
  ).toBe(2);
  expect(out.join('')).toMatch(/pnpm meshcentral:agents/);
});
