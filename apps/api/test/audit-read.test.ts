import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { auditEvents } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { createTestDb, type TestDb } from './support/db.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedUser } from './support/seed.ts';

let t: TestDb;
let app: TestApp;
let a: { orgId: string; siteId: string; otherSiteId: string };

beforeAll(async () => {
  t = await createTestDb();
  app = await startTestApp({ db: t });
});
afterAll(async () => {
  await app?.close();
  await t?.close();
});
beforeEach(async () => {
  await t.reset();
  a = await seedOrg(t.db, 'A');
  const b = await seedOrg(t.db, 'B');
  await seedUser(t.db, a.orgId, 'a-admin', [{ role: 'school_admin', siteId: null }]);
  await seedUser(t.db, a.orgId, 'a-site-admin', [{ role: 'school_admin', siteId: a.siteId }]);
  await seedUser(t.db, a.orgId, 'a-teacher', [{ role: 'teacher', siteId: a.siteId }]);
  const base = Date.parse('2026-10-01T00:00:00Z');
  const rows = Array.from({ length: 7 }, (_, i) => ({
    organizationId: a.orgId,
    siteId: i % 2 === 0 ? a.siteId : a.otherSiteId,
    action: 'room.update',
    result: 'succeeded',
    correlationId: `seed-${i}`,
    at: new Date(base + Math.floor(i / 2) * 1000), // ba'zilari bir xil vaqtda — cursor id bo'yicha ham ajratadi
  }));
  await t.db
    .insert(auditEvents)
    .values([
      ...rows,
      { organizationId: b.orgId, action: 'room.update', result: 'succeeded', correlationId: 'other-org' },
    ]);
});

async function collect(cookie: string, query: string) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await app.request('GET', `/api/v1/audit-events?limit=2${query}${cursor ? `&before=${cursor}` : ''}`, {
      cookie,
    });
    expect(res.status).toBe(200);
    expect(res.json.events.length).toBeLessThanOrEqual(2);
    seen.push(...res.json.events.map((e: { correlationId: string }) => e.correlationId));
    cursor = res.json.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return seen;
}

test('audit read is scoped by site and paginates with a stable cursor', async () => {
  const admin = await loginAs(app, 'a-admin');
  const all = (await collect(admin, '')).filter((c) => c.startsWith('seed-') || c === 'other-org');
  expect(all.sort()).toEqual(['seed-0', 'seed-1', 'seed-2', 'seed-3', 'seed-4', 'seed-5', 'seed-6']);

  const siteAdmin = await loginAs(app, 'a-site-admin');
  const scoped = await collect(siteAdmin, `&siteId=${a.siteId}`);
  expect(scoped.filter((c) => c.startsWith('seed-')).sort()).toEqual(['seed-0', 'seed-2', 'seed-4', 'seed-6']);
  expect((await app.request('GET', '/api/v1/audit-events', { cookie: siteAdmin })).status).toBe(403);
  expect((await app.request('GET', `/api/v1/audit-events?siteId=${a.otherSiteId}`, { cookie: siteAdmin })).status).toBe(
    403,
  );
});

test('limit is bounded and bad cursors are rejected', async () => {
  const admin = await loginAs(app, 'a-admin');
  expect((await app.request('GET', '/api/v1/audit-events?limit=201', { cookie: admin })).status).toBe(400);
  expect((await app.request('GET', '/api/v1/audit-events?before=garbage', { cookie: admin })).status).toBe(400);
});

test('teacher cannot read audit events', async () => {
  const cookie = await loginAs(app, 'a-teacher');
  expect((await app.request('GET', `/api/v1/audit-events?siteId=${a.siteId}`, { cookie })).status).toBe(403);
});

test('cursor pagination keeps rows that share a millisecond', async () => {
  await t.reset();
  const c = await seedOrg(t.db, 'C');
  await seedUser(t.db, c.orgId, 'c-admin', [{ role: 'school_admin', siteId: null }]);
  // Bir millisekund ichida, mikrosekundlari farqli to'rtta yozuv.
  for (const [i, at] of ['10:00:00.000100', '10:00:00.000200', '10:00:00.000300', '10:00:00.000400'].entries()) {
    await t.db.execute(
      sql`insert into audit_events (organization_id, action, result, correlation_id, at) values (${c.orgId}, 'room.update', 'succeeded', ${`micro-${i}`}, ${`2026-10-02 ${at}+00`}::timestamptz)`,
    );
  }
  const cookie = await loginAs(app, 'c-admin');
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await app.request('GET', `/api/v1/audit-events?limit=1${cursor ? `&before=${cursor}` : ''}`, {
      cookie,
    });
    seen.push(...res.json.events.map((e: { correlationId: string }) => e.correlationId));
    cursor = res.json.nextCursor ?? undefined;
    if (!cursor) break;
  }
  expect(seen.filter((s) => s.startsWith('micro-'))).toEqual(['micro-3', 'micro-2', 'micro-1', 'micro-0']);
});
