import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, deviceCapabilities, devices, enrollments } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { type DeviceKey, makeDeviceKey } from './support/device.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let siteId: string;
let otherSiteId: string;
let roomId: string;
let admin: string;

const report = {
  protocolVersion: 1,
  os: 'linux',
  architecture: 'x64',
  desktopSession: 'x11',
  capabilities: { 'screen.view': { state: 'available' } },
};

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  now += 61_000; // claim IP oynasi har testda yangidan
  await app.db.reset();
  ({ orgId, siteId, otherSiteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  admin = await loginAs(app, 'admin1');
});
afterAll(async () => {
  await app?.close();
});

async function createToken(body: Record<string, unknown> = { siteId, roomId }, cookie = admin) {
  const res = await app.request('POST', '/api/v1/enrollments', { body, cookie });
  expect(res.status).toBe(201);
  return res.json as { id: string; token: string; expiresAt: string };
}

function claim(token: string, key: DeviceKey = makeDeviceKey(), extra: Record<string, unknown> = {}) {
  return app.request('POST', '/api/v1/enrollments/claim', {
    origin: null,
    body: {
      token,
      publicKey: key.publicKey,
      proof: key.sign(`NSCLAIM1\n${token}\n${key.publicKey}`),
      hostname: 'pc-01.school.lan',
      capabilities: report,
      ...extra,
    },
  });
}

async function claimAudits() {
  return app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'device.claim'));
}

describe('enrollments', () => {
  test('admin creates a one-time token shown once', async () => {
    const created = await createToken();
    expect(created.token).toMatch(/^nse_[A-Za-z0-9_-]{43}$/);
    expect(new Date(created.expiresAt).getTime()).toBe(now + 60 * 60_000);
    const list = await app.request('GET', `/api/v1/sites/${siteId}/enrollments`, { cookie: admin });
    expect(list.status).toBe(200);
    expect(list.json.enrollments).toHaveLength(1);
    expect(list.json.enrollments[0]).toMatchObject({ id: created.id, status: 'pending', roomId, deviceId: null });
    expect(JSON.stringify(list.json)).not.toContain(created.token);
    const [row] = await app.db.db.select().from(enrollments);
    expect(Buffer.from(row?.tokenHash ?? []).equals(createHash('sha256').update(created.token).digest())).toBe(true);
    const audits = await app.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'enrollment.create'));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(created.token);
  });

  test('it_support enrolls in own site only', async () => {
    await seedUser(app.db.db, orgId, 'it1', [{ role: 'it_support', siteId }]);
    const it = await loginAs(app, 'it1');
    await createToken({ siteId }, it);
    const denied = await app.request('POST', '/api/v1/enrollments', { body: { siteId: otherSiteId }, cookie: it });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('scope_denied');
    const audits = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'device.enroll'), eq(auditEvents.result, 'denied')));
    expect(audits).toHaveLength(1);
  });

  test('teacher cannot create enrollments', async () => {
    await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
    const teacher = await loginAs(app, 'teacher1');
    const res = await app.request('POST', '/api/v1/enrollments', { body: { siteId, roomId }, cookie: teacher });
    expect(res.status).toBe(403);
    expect((await app.request('GET', `/api/v1/sites/${siteId}/enrollments`, { cookie: teacher })).status).toBe(403);
  });

  test('device claims with token, key and proof', async () => {
    const created = await createToken();
    const res = await claim(created.token);
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ deviceId: expect.any(String), siteId, heartbeatIntervalSeconds: 10 });
    const [device] = await app.db.db.select().from(devices);
    expect(device).toMatchObject({ id: res.json.deviceId, siteId, roomId, hostname: 'pc-01.school.lan' });
    const [caps] = await app.db.db.select().from(deviceCapabilities);
    expect(caps?.report).toEqual(report);
    const list = await app.request('GET', `/api/v1/sites/${siteId}/enrollments`, { cookie: admin });
    expect(list.json.enrollments[0]).toMatchObject({ status: 'claimed', deviceId: res.json.deviceId });
    const audits = await claimAudits();
    expect(audits.map((a) => [a.result, a.organizationId, a.targetId])).toEqual([
      ['succeeded', orgId, res.json.deviceId],
    ]);
  });

  test('parallel claims with one token create exactly one device', async () => {
    const created = await createToken();
    const results = await Promise.all(Array.from({ length: 10 }, () => claim(created.token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(9);
    expect(await app.db.db.select().from(devices)).toHaveLength(1);
  });

  test('token is rejected at expiry and after revoke', async () => {
    const short = await createToken({ siteId, expiresInMinutes: 5 });
    now += 5 * 60_000;
    expect((await claim(short.token)).status).toBe(401);
    admin = await loginAs(app, 'admin1');
    const revoked = await createToken();
    expect((await app.request('DELETE', `/api/v1/enrollments/${revoked.id}`, { cookie: admin })).status).toBe(204);
    expect((await claim(revoked.token)).status).toBe(401);
    expect((await app.request('DELETE', `/api/v1/enrollments/${revoked.id}`, { cookie: admin })).status).toBe(409);
    const list = await app.request('GET', `/api/v1/sites/${siteId}/enrollments`, { cookie: admin });
    expect(list.json.enrollments.map((e: { status: string }) => e.status).sort()).toEqual(['expired', 'revoked']);
  });

  test('claim with wrong proof is rejected and audited', async () => {
    const created = await createToken();
    const key = makeDeviceKey();
    const bad = await claim(created.token, key, { proof: key.sign(`NSCLAIM1\nother\n${key.publicKey}`) });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe('unauthenticated');
    const unknown = await claim(`nse_${'Z'.repeat(43)}`);
    expect(unknown.status).toBe(401);
    const audits = await claimAudits();
    expect(audits.map((a) => [a.result, a.organizationId, (a.details as { reason: string }).reason])).toEqual([
      ['failed', orgId, 'invalid_proof'],
      ['failed', null, 'invalid_token'],
    ]);
    // Noto'g'ri proof tokenni sarflamaydi.
    expect((await claim(created.token, key)).status).toBe(201);
  });

  test('reusing a device key is a conflict', async () => {
    const key = makeDeviceKey();
    const first = await createToken();
    const second = await createToken();
    expect((await claim(first.token, key)).status).toBe(201);
    const again = await claim(second.token, key);
    expect(again.status).toBe(409);
    const list = await app.request('GET', `/api/v1/sites/${siteId}/enrollments`, { cookie: admin });
    const statuses = Object.fromEntries(
      list.json.enrollments.map((e: { id: string; status: string }) => [e.id, e.status]),
    );
    expect(statuses[second.id]).toBe('pending');
  });

  test('claim is rate limited per IP', async () => {
    const token = `nse_${'Q'.repeat(43)}`;
    for (let i = 0; i < 30; i++) expect((await claim(token)).status).toBe(401);
    const limited = await claim(token);
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('rate_limited');
  });

  test('enrollment room from another site is denied', async () => {
    const otherRoom = await seedRoom(app.db.db, orgId, otherSiteId, '201');
    const res = await app.request('POST', '/api/v1/enrollments', {
      body: { siteId, roomId: otherRoom },
      cookie: admin,
    });
    expect(res.status).toBe(403);
    expect(await app.db.db.select().from(enrollments)).toHaveLength(0);
  });
});
