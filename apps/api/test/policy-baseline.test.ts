import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, policyVersions } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedUser } from './support/seed.ts';

let app: TestApp;
let siteId: string;
let otherSiteId: string;
let admin: string;

beforeAll(async () => {
  app = await startTestApp({});
});
beforeEach(async () => {
  await app.db.reset();
  let orgId: string;
  ({ orgId, siteId, otherSiteId } = await seedOrg(app.db.db));
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  await seedUser(app.db.db, orgId, 'it1', [{ role: 'it_support', siteId }]);
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }]);
  admin = await loginAs(app, 'admin1');
});
afterAll(async () => {
  await app?.close();
});

const doc = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, ...over });
const path = (site?: string) => `/api/v1/policies/baseline${site ? `?siteId=${site}` : ''}`;
const put = (body: unknown, ifMatch: string | null, cookie = admin, site?: string) =>
  app.request('PUT', path(site), { body, cookie, headers: ifMatch === null ? {} : { 'if-match': ifMatch } });

describe('baseline policy', () => {
  test('org admin creates org and site baseline versions', async () => {
    const org = await put(doc({ web: { blocked: ['Bad.com'] }, browser: { managed: true } }), '0');
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    expect(org.json).toMatchObject({ layer: 'baseline', siteId: null, version: 1, restoredFrom: null });
    expect(org.json.document.web.blocked).toEqual(['bad.com']);
    const site = await put(
      doc({ web: { blocked: ['game.com'] }, browser: { incognito: 'disabled' } }),
      '0',
      admin,
      siteId,
    );
    expect(site.status).toBe(201);
    expect(site.json.siteId).toBe(siteId);

    const got = await app.request('GET', path(siteId), { cookie: admin });
    expect(got.status).toBe(200);
    expect(got.json.current.id).toBe(site.json.id);
    expect(got.json.effective).toEqual({
      web: { blocked: ['bad.com', 'game.com'] },
      browser: { managed: true, incognito: 'disabled', devTools: 'allowed' },
      os: { standardUser: false, blockAppInstall: false, lockWallpaper: false },
    });
    const [audit] = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'policy.baseline_changed'));
    expect(audit).toMatchObject({ targetType: 'policy_version', result: 'succeeded' });
  });

  test('empty scope returns defaults and no current version', async () => {
    const got = await app.request('GET', path(), { cookie: admin });
    expect(got.json.current).toBeNull();
    expect(got.json.effective.browser.managed).toBe(false);
  });

  test('stale If-Match is rejected with 409 conflict', async () => {
    expect((await put(doc(), '0')).status).toBe(201);
    const [a, b] = await Promise.all([
      put(doc({ web: { blocked: ['a.com'] } }), '1'),
      put(doc({ web: { blocked: ['b.com'] } }), '1'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).json.error.code).toBe('conflict');
    const rows = await app.db.db.select().from(policyVersions);
    expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
  });

  test('missing If-Match is a validation error', async () => {
    expect((await put(doc(), null)).json.error.code).toBe('validation_failed');
  });

  test('identical content does not create a version', async () => {
    await put(doc({ web: { blocked: ['a.com'] } }), '0');
    const again = await put(doc({ web: { blocked: ['A.com'] } }), '1');
    expect(again.status).toBe(200);
    expect(again.json.version).toBe(1);
  });

  test('it_support manages only its own site', async () => {
    const it = await loginAs(app, 'it1');
    expect((await put(doc(), '0', it, siteId)).status).toBe(201);
    const other = await put(doc(), '0', it, otherSiteId);
    expect(other.status).toBe(403);
    expect(other.json.error.code).toBe('scope_denied');
    expect((await put(doc(), '0', it)).status).toBe(403);
    const denied = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'policy.manage'), eq(auditEvents.result, 'denied')));
    expect(denied.length).toBe(2);
    const teacher = await loginAs(app, 'teacher1');
    expect((await put(doc(), '0', teacher, siteId)).status).toBe(403);
  });

  test('restore creates a new version from old content', async () => {
    const v1 = await put(doc({ web: { blocked: ['a.com'] } }), '0');
    await put(doc({ web: { blocked: ['b.com'] } }), '1');
    const restored = await app.request('POST', `/api/v1/policies/baseline/versions/${v1.json.id}/restore`, {
      cookie: admin,
      headers: { 'if-match': '2' },
    });
    expect(restored.status, JSON.stringify(restored.json)).toBe(201);
    expect(restored.json).toMatchObject({ version: 3, restoredFrom: v1.json.id, document: v1.json.document });
    const list = await app.request('GET', '/api/v1/policies/baseline/versions', { cookie: admin });
    expect(list.json.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
  });

  test('restore of another scope version is denied', async () => {
    const otherV = await put(doc(), '0', admin, otherSiteId);
    const res = await app.request('POST', `/api/v1/policies/baseline/versions/${otherV.json.id}/restore`, {
      cookie: await loginAs(app, 'it1'),
      headers: { 'if-match': '1' },
    });
    expect(res.status).toBe(403);
    const missing = await app.request('POST', '/api/v1/policies/baseline/versions/not-a-uuid/restore', {
      cookie: admin,
      headers: { 'if-match': '1' },
    });
    expect(missing.status).toBe(403);
  });

  test('versions are immutable in the database', async () => {
    await put(doc(), '0');
    await expect(app.db.db.execute(sql`update policy_versions set version = 9`)).rejects.toThrow();
    await expect(app.db.db.execute(sql`delete from policy_versions`)).rejects.toThrow();
  });

  test('invalid documents are rejected', async () => {
    for (const body of [
      doc({ unknown: true }),
      doc({ web: { blocked: ['exa(mple).com'] } }),
      doc({ web: { blocked: Array.from({ length: 501 }, (_, i) => `s${i}.com`) } }),
      { schemaVersion: 2 },
    ]) {
      const res = await put(body, '0');
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });
});
