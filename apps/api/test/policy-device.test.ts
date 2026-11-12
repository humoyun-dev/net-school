import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { auditEvents, policyReceipts } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { type DeviceKey, deviceRequest, helperRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

const CHROME_ID = 'a'.repeat(32);
let now = 1_800_000_000_000;
let app: TestApp;
let siteId: string;
let otherRoomId: string;
let roomId: string;
let teacher: string;
let admin: string;
let companionKey: DeviceKey;
let helperKey: DeviceKey;
let deviceId: string;

const DEVICE_POLICY = '/api/v1/device/policy';
const DEVICE_RECEIPT = '/api/v1/device/policy/receipt';
const HELPER_POLICY = '/api/v1/device/helper/policy';
const HELPER_RECEIPT = '/api/v1/device/helper/policy/receipt';

beforeAll(async () => {
  app = await startTestApp({ now: () => now, extensionIds: { chrome: CHROME_ID, edge: null } });
});
beforeEach(async () => {
  now += 61_000;
  await app.db.reset();
  let orgId: string;
  ({ orgId, siteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  otherRoomId = await seedRoom(app.db.db, orgId, siteId, '102');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  await seedUser(app.db.db, orgId, 'teacher2', [{ role: 'teacher', siteId }], { roomIds: [otherRoomId] });
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  teacher = await loginAs(app, 'teacher1');
  admin = await loginAs(app, 'admin1');
  companionKey = makeDeviceKey();
  helperKey = makeDeviceKey();
  deviceId = await seedDevice(app.db.db, orgId, siteId, companionKey.publicKey, { roomId, helperKey });
});
afterAll(async () => {
  await app?.close();
});

const asCompanion = (method: string, path: string, body?: unknown) => {
  now += 1;
  return deviceRequest(app, companionKey, deviceId, method, path, body, now);
};
const asHelper = (method: string, path: string, body?: unknown) => {
  now += 1;
  return helperRequest(app, helperKey, deviceId, method, path, body, now);
};
const putBaseline = (body: unknown, ifMatch: string, site?: string) =>
  app.request('PUT', `/api/v1/policies/baseline${site ? `?siteId=${site}` : ''}`, {
    body: { schemaVersion: 1, ...(body as object) },
    cookie: admin,
    headers: { 'if-match': ifMatch },
  });
const putLesson = (lessonId: string, mode: string, patterns: string[], ifMatch = '0') =>
  app.request('PUT', `/api/v1/lessons/${lessonId}/policy`, {
    body: { schemaVersion: 1, web: { mode, patterns } },
    cookie: teacher,
    headers: { 'if-match': ifMatch },
  });
const status = async () => {
  const res = await app.request('GET', `/api/v1/policies/status?roomId=${roomId}`, { cookie: admin });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.devices.find((d: { deviceId: string }) => d.deviceId === deviceId);
};

describe('device policy', () => {
  test('device receives merged baseline and lesson layer', async () => {
    await putBaseline({ web: { blocked: ['bad.com'] } }, '0');
    await putBaseline({ browser: { managed: true } }, '0', siteId);
    const lessonId = (await startLesson(app, teacher, roomId)).json.id;
    await putLesson(lessonId, 'allowlist', ['docs.example.com']);

    const res = await asCompanion('GET', DEVICE_POLICY);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.baseline.revision).toEqual({ org: 1, site: 1 });
    expect(res.json.baseline.document.web.blocked).toEqual(['bad.com']);
    expect(res.json.baseline.document.browser.managed).toBe(true);
    expect(res.json.baseline.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.json.lesson).toMatchObject({ lessonId, version: 1, leaseSeconds: 120 });
    expect(res.json.lesson.document.web).toEqual({ mode: 'allowlist', patterns: ['docs.example.com'] });

    await endLesson(app, teacher, lessonId);
    expect((await asCompanion('GET', DEVICE_POLICY)).json.lesson).toBeNull();
  });

  test('helper gets baseline and extension ids only via its own route', async () => {
    expect((await asCompanion('GET', HELPER_POLICY)).status).toBe(401);
    expect((await asHelper('GET', DEVICE_POLICY)).status).toBe(401);
    const res = await asHelper('GET', HELPER_POLICY);
    expect(res.status).toBe(200);
    expect(res.json.extensions).toEqual({ chrome: CHROME_ID, edge: null });
    expect(res.json.baseline.revision).toEqual({ org: 0, site: 0 });
    expect(res.json).not.toHaveProperty('lesson');
  });

  test('heartbeat and lock-state carry the policy hint', async () => {
    const before = await asCompanion('POST', '/api/v1/device/heartbeat', {});
    expect(before.json.policy).toEqual({ baseline: { org: 0, site: 0 }, lesson: null });
    await putBaseline({ web: { blocked: ['bad.com'] } }, '0');
    const lessonId = (await startLesson(app, teacher, roomId)).json.id;
    await putLesson(lessonId, 'blocklist', ['game.com']);
    const after = await asCompanion('POST', '/api/v1/device/heartbeat', {});
    expect(after.json.policy).toEqual({ baseline: { org: 1, site: 0 }, lesson: { lessonId, version: 1 } });
    expect((await asHelper('GET', '/api/v1/device/helper/lock-state')).json.baseline).toEqual({ org: 1, site: 0 });
  });

  test('an older receipt does not overwrite a newer one', async () => {
    await putBaseline({ web: { blocked: ['a.com'] } }, '0');
    const v1 = (await asCompanion('GET', DEVICE_POLICY)).json.baseline;
    await putBaseline({ web: { blocked: ['b.com'] } }, '1');
    const v2 = (await asCompanion('GET', DEVICE_POLICY)).json.baseline;
    const receipt = (b: { revision: unknown; hash: string }) => ({
      layer: 'baseline',
      revision: b.revision,
      hash: b.hash,
      rules: { 'web.blocked': { state: 'applied' } },
    });
    expect((await asCompanion('PUT', DEVICE_RECEIPT, receipt(v2))).status).toBe(204);
    expect((await asCompanion('PUT', DEVICE_RECEIPT, receipt(v1))).status).toBe(204);
    const [row] = await app.db.db.select().from(policyReceipts).where(eq(policyReceipts.deviceId, deviceId));
    expect(row?.applied).toEqual({ org: 2, site: 0 });
    expect(row?.contentHash).toBe(v2.hash);
  });

  test('status combines helper and companion receipts', async () => {
    await putBaseline({ web: { blocked: ['a.com'] }, browser: { managed: true } }, '0');
    const b = (await asCompanion('GET', DEVICE_POLICY)).json.baseline;
    const base = { layer: 'baseline', revision: b.revision, hash: b.hash };
    await asCompanion('PUT', DEVICE_RECEIPT, { ...base, rules: { 'web.blocked': { state: 'applied' } } });
    expect((await status()).baseline.status).toBe('pending');
    await asHelper('PUT', HELPER_RECEIPT, {
      ...base,
      rules: {
        'browser.managed': { state: 'applied' },
        'browser.onlyManaged': { state: 'failed', code: 'unmanaged_browser' },
      },
    });
    const partial = await status();
    expect(partial.baseline.status).toBe('partial');
    expect(partial.baseline.helper.rules['browser.onlyManaged']).toEqual({
      state: 'failed',
      code: 'unmanaged_browser',
    });
    await asHelper('PUT', HELPER_RECEIPT, {
      ...base,
      rules: { 'browser.managed': { state: 'applied' }, 'browser.onlyManaged': { state: 'applied' } },
    });
    expect((await status()).baseline.status).toBe('applied');
    await putBaseline({ web: { blocked: ['b.com'] }, browser: { managed: true } }, '1');
    expect((await status()).baseline.status).toBe('pending');
  });

  test('lesson layer status follows the companion receipt', async () => {
    const lessonId = (await startLesson(app, teacher, roomId)).json.id;
    expect((await status()).lesson).toBeNull();
    await putLesson(lessonId, 'allowlist', ['x.com']);
    const l = (await asCompanion('GET', DEVICE_POLICY)).json.lesson;
    expect((await status()).lesson).toMatchObject({ desired: { lessonId, version: 1 }, status: 'pending' });
    await asCompanion('PUT', DEVICE_RECEIPT, {
      layer: 'lesson',
      lessonId,
      version: 1,
      hash: l.hash,
      rules: { 'web.lesson': { state: 'applied' } },
    });
    expect((await status()).lesson.status).toBe('applied');
  });

  test('helper cannot report the lesson layer', async () => {
    const lessonId = (await startLesson(app, teacher, roomId)).json.id;
    const res = await asHelper('PUT', HELPER_RECEIPT, {
      layer: 'lesson',
      lessonId,
      version: 1,
      hash: '0'.repeat(64),
      rules: {},
    });
    expect(res.status).toBe(400);
  });

  test('drift repair is audited', async () => {
    await putBaseline({ browser: { managed: true, incognito: 'disabled' } }, '0');
    const b = (await asHelper('GET', HELPER_POLICY)).json.baseline;
    await asHelper('PUT', HELPER_RECEIPT, {
      layer: 'baseline',
      revision: b.revision,
      hash: b.hash,
      rules: { 'browser.incognito': { state: 'applied' } },
      repaired: ['browser.incognito'],
    });
    const rows = await app.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'policy.drift_repaired'), eq(auditEvents.targetId, deviceId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toMatchObject({ rules: ['browser.incognito'] });
  });

  test('status is scoped to readable rooms', async () => {
    const other = await app.request('GET', `/api/v1/policies/status?roomId=${roomId}`, {
      cookie: await loginAs(app, 'teacher2'),
    });
    expect(other.status).toBe(403);
    const own = await app.request('GET', `/api/v1/policies/status?roomId=${roomId}`, { cookie: teacher });
    expect(own.status).toBe(200);
  });

  test('a new lesson with the same allowlist does not reuse the old receipt', async () => {
    const first = (await startLesson(app, teacher, roomId)).json.id;
    await putLesson(first, 'allowlist', ['x.com']);
    const l = (await asCompanion('GET', DEVICE_POLICY)).json.lesson;
    await asCompanion('PUT', DEVICE_RECEIPT, {
      layer: 'lesson',
      lessonId: first,
      version: 1,
      hash: l.hash,
      rules: { 'web.lesson': { state: 'applied' } },
    });
    expect((await status()).lesson.status).toBe('applied');
    await endLesson(app, teacher, first);
    const second = (await startLesson(app, teacher, roomId)).json.id;
    await putLesson(second, 'allowlist', ['x.com']);
    expect((await status()).lesson).toMatchObject({ desired: { lessonId: second }, status: 'pending' });
  });

  test('a receipt older than the staleness window is pending', async () => {
    await putBaseline({ web: { blocked: ['a.com'] } }, '0');
    const b = (await asCompanion('GET', DEVICE_POLICY)).json.baseline;
    await asCompanion('PUT', DEVICE_RECEIPT, {
      layer: 'baseline',
      revision: b.revision,
      hash: b.hash,
      rules: { 'web.blocked': { state: 'applied' } },
    });
    expect((await status()).baseline.status).toBe('applied');
    now += 16 * 60_000;
    expect((await status()).baseline.status).toBe('pending');
  });
});
