import { generateKeyPairSync } from 'node:crypto';
import { deviceSchema } from '@netschool/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { auditEvents, deviceCapabilities, devices } from '../src/db/schema.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { setCapabilities, setHeartbeat } from './support/caps.ts';
import { type DeviceKey, deviceRequest, helperRequest, makeDeviceKey, seedDevice } from './support/device.ts';
import { endLesson, issueCommand, startLesson } from './support/lesson.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedRoom, seedUser } from './support/seed.ts';

let now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let siteId: string;
let roomId: string;
let teacher: string;
let admin: string;
let companionKey: DeviceKey;
let helperKey: DeviceKey;
let deviceId: string;

const LOCK_STATE = '/api/v1/device/helper/lock-state';
const STATUS = '/api/v1/device/helper/status';
const HEARTBEAT = '/api/v1/device/heartbeat';
const CAPABILITIES = '/api/v1/device/capabilities';

const status = {
  version: '0.1.0',
  hook: 'active',
  policy: 'active',
  processGuard: 'off',
  cad: 'blocked',
  companion: 'running',
  meshAgent: 'running',
};

const report = {
  protocolVersion: 1,
  os: 'windows',
  architecture: 'x64',
  desktopSession: 'windows',
  capabilities: { 'screen.view': { state: 'available' } },
};

beforeAll(async () => {
  app = await startTestApp({ now: () => now });
});
beforeEach(async () => {
  now += 61_000; // claim IP oynasi har testda yangidan
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
  roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  teacher = await loginAs(app, 'teacher1');
  admin = await loginAs(app, 'admin1');
  companionKey = makeDeviceKey();
  helperKey = makeDeviceKey();
  deviceId = await seedDevice(app.db.db, orgId, siteId, companionKey.publicKey, { roomId, helperKey });
  await setCapabilities(app.db.db, orgId, deviceId, { 'classroom.overlay': { state: 'available' } });
  await setHeartbeat(app.db.db, deviceId, now);
});
afterAll(async () => {
  await app?.close();
});

// Har so'rov yangi timestamp bilan; ts berilsa, soat shunga yetkaziladi (oyna ±30 s ichida qoladi).
const asHelper = (method: string, path: string, body?: unknown, ts = now + 1) => {
  now = Math.max(now, ts);
  return helperRequest(app, helperKey, deviceId, method, path, body, ts);
};
const asCompanion = (method: string, path: string, body?: unknown, ts = now + 1) => {
  now = Math.max(now, ts);
  return deviceRequest(app, companionKey, deviceId, method, path, body, ts);
};
const deviceRow = async () => {
  const [row] = await app.db.db.select().from(devices).where(eq(devices.id, deviceId));
  if (!row) throw new Error('device');
  return row;
};

describe('helper device key', () => {
  test('helper key signs only helper routes', async () => {
    // Helper imzosi Companion yo'lida (sarlavha bilan ham, sarlavhasiz ham) rad etiladi.
    expect((await asHelper('POST', HEARTBEAT, {})).status).toBe(401);
    const noHeader = await deviceRequest(app, helperKey, deviceId, 'POST', HEARTBEAT, {}, ++now);
    expect(noHeader.status).toBe(401);
    expect(noHeader.json.error.code).toBe('unauthenticated');
    // Companion imzosi helper yo'lida rad etiladi (sarlavhasiz ham, 'helper' sarlavhasi bilan ham).
    const wrong = await asCompanion('GET', LOCK_STATE);
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('unauthenticated');
    const stamped = await deviceRequest(app, companionKey, deviceId, 'GET', LOCK_STATE, undefined, ++now, 'helper');
    expect(stamped.status).toBe(401);
    // To'g'ri juftliklar o'tadi; 'companion' sarlavhasi ochiq aytilsa ham Companion hisoblanadi.
    expect((await asHelper('GET', LOCK_STATE)).status).toBe(200);
    expect((await asCompanion('POST', HEARTBEAT, {})).status).toBe(200);
    const explicit = await deviceRequest(app, companionKey, deviceId, 'POST', HEARTBEAT, {}, ++now, 'companion');
    expect(explicit.status).toBe(200);
  });

  test('unknown signer values are unauthenticated', async () => {
    for (const signer of ['', 'Helper', 'admin', 'helper, helper']) {
      const h = await deviceRequest(app, helperKey, deviceId, 'GET', LOCK_STATE, undefined, ++now, signer);
      expect(h.status, `helper route, signer=${JSON.stringify(signer)}`).toBe(401);
      const c = await deviceRequest(app, companionKey, deviceId, 'POST', HEARTBEAT, {}, ++now, signer);
      expect(c.status, `companion route, signer=${JSON.stringify(signer)}`).toBe(401);
    }
  });

  test('device without a helper key cannot use helper routes', async () => {
    const key = makeDeviceKey();
    const id = await seedDevice(app.db.db, orgId, siteId, key.publicKey, { hostname: 'pc-02' });
    // Companion kaliti bilan ham, begona helper kaliti bilan ham.
    expect((await helperRequest(app, key, id, 'GET', LOCK_STATE, undefined, ++now)).status).toBe(401);
    expect((await helperRequest(app, helperKey, id, 'GET', LOCK_STATE, undefined, ++now)).status).toBe(401);
  });

  test('retired device helper is rejected', async () => {
    await app.db.db
      .update(devices)
      .set({ retiredAt: new Date(now) })
      .where(eq(devices.id, deviceId));
    expect((await asHelper('GET', LOCK_STATE)).status).toBe(401);
  });

  test('companion and helper timestamps do not collide', async () => {
    const base = now;
    expect((await asCompanion('POST', HEARTBEAT, {}, base + 1000)).status).toBe(200);
    // Helper'ning timestamp'i Companion'nikidan kichik, lekin hisoblagich alohida.
    expect((await asHelper('GET', LOCK_STATE, undefined, base + 900)).status).toBe(200);
    const row = await deviceRow();
    expect(row.lastSignedTs).toBe(base + 1000);
    expect(row.helperLastSignedTs).toBe(base + 900);
    // Har tomonning o'z replay himoyasi saqlanadi.
    expect((await asHelper('GET', LOCK_STATE, undefined, base + 900)).status).toBe(401);
    expect((await asCompanion('POST', HEARTBEAT, {}, base + 1000)).status).toBe(401);
    expect((await asHelper('GET', LOCK_STATE, undefined, base + 901)).status).toBe(200);
  });
});

describe('helper lock state', () => {
  test('without a lesson nothing is locked', async () => {
    const res = await asHelper('GET', LOCK_STATE);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ locked: false, sequence: null, leaseSeconds: 120 });
  });

  test('lock-state mirrors the active lesson overlay', async () => {
    const lessonId = (await startLesson(app, teacher, roomId)).json.id;
    expect((await asHelper('GET', LOCK_STATE)).json).toEqual({ locked: false, sequence: null, leaseSeconds: 120 });
    const lock = (await issueCommand(app, teacher, lessonId, { type: 'overlay.lock', payload: {} })).json;
    expect(lock.sequence).toEqual(expect.any(String));
    const locked = await asHelper('GET', LOCK_STATE);
    expect(locked.status).toBe(200);
    expect(locked.json).toEqual({ locked: true, sequence: lock.sequence, leaseSeconds: 120 });
    // Heartbeat bilan bir manba: overlay holati mos.
    const beat = await asCompanion('POST', HEARTBEAT, {});
    expect(beat.json.lesson.overlay).toMatchObject({ locked: true, sequence: lock.sequence, leaseSeconds: 120 });
    await endLesson(app, teacher, lessonId);
    expect((await asHelper('GET', LOCK_STATE)).json).toEqual({ locked: false, sequence: null, leaseSeconds: 120 });
  });

  test('lock-state has no presence side effect', async () => {
    const before = await deviceRow();
    const audits = await app.db.db.select().from(auditEvents);
    expect((await asHelper('GET', LOCK_STATE)).status).toBe(200);
    const after = await deviceRow();
    expect(after.lastHeartbeatAt?.getTime()).toBe(before.lastHeartbeatAt?.getTime());
    expect(await app.db.db.select().from(auditEvents)).toHaveLength(audits.length);
  });
});

describe('helper status', () => {
  test('status is validated and stored with its received time', async () => {
    const before = await deviceRow();
    const audits = (await app.db.db.select().from(auditEvents)).length;
    const res = await asHelper('PUT', STATUS, status);
    expect(res.status).toBe(204);
    const row = await deviceRow();
    expect(row.helperStatus).toEqual(status);
    expect(row.helperStatusAt?.getTime()).toBe(now);
    // Presence va audit o'zgarmaydi: bu Companion heartbeat'i emas.
    expect(row.lastHeartbeatAt?.getTime()).toBe(before.lastHeartbeatAt?.getTime());
    expect(await app.db.db.select().from(auditEvents)).toHaveLength(audits);
    // Keyingi hisobot oldingisini almashtiradi.
    const next = { ...status, hook: 'failed', companion: 'restarting' };
    expect((await asHelper('PUT', STATUS, next)).status).toBe(204);
    const again = await deviceRow();
    expect(again.helperStatus).toEqual(next);
    expect(again.helperStatusAt?.getTime()).toBe(now);
  });

  test('invalid status is a validation error and stores nothing', async () => {
    for (const body of [
      {},
      { ...status, hook: 'maybe' },
      { ...status, cad: 'active' },
      { ...status, companion: 'gone' },
      { ...status, meshAgent: 'unknown' },
      { ...status, version: undefined },
    ]) {
      const res = await asHelper('PUT', STATUS, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('validation_failed');
    }
    const row = await deviceRow();
    expect(row.helperStatus).toBeNull();
    expect(row.helperStatusAt).toBeNull();
  });

  test('companion key cannot report helper status', async () => {
    expect((await asCompanion('PUT', STATUS, status)).status).toBe(401);
    expect((await deviceRow()).helperStatus).toBeNull();
  });
});

describe('claim with a helper key', () => {
  async function createToken() {
    const res = await app.request('POST', '/api/v1/enrollments', { body: { siteId, roomId }, cookie: admin });
    expect(res.status).toBe(201);
    return res.json.token as string;
  }
  function claim(token: string, key: DeviceKey, extra: Record<string, unknown>) {
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
  const helperClaim = (token: string, hk: DeviceKey, signer: DeviceKey = hk) => ({
    helperPublicKey: hk.publicKey,
    helperProof: signer.sign(`NSCLAIM1\n${token}\n${hk.publicKey}`),
  });
  const deviceCount = async () => (await app.db.db.select().from(devices)).length;

  test('claim stores the helper key only with a valid proof', async () => {
    const token = await createToken();
    const key = makeDeviceKey();
    const hk = makeDeviceKey();
    const before = await deviceCount();

    // Boshqa kalit imzolagan proof.
    const wrong = await claim(token, key, helperClaim(token, hk, makeDeviceKey()));
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe('validation_failed');
    // Boshqa token uchun imzolangan proof.
    const other = await claim(token, key, {
      helperPublicKey: hk.publicKey,
      helperProof: hk.sign(`NSCLAIM1\nnse_${'x'.repeat(43)}\n${hk.publicKey}`),
    });
    expect(other.status).toBe(400);
    expect(await deviceCount()).toBe(before);

    // Noto'g'ri proof tokenni sarflamaydi: to'g'ri proof bilan o'sha token o'tadi.
    const ok = await claim(token, key, helperClaim(token, hk));
    expect(ok.status).toBe(201);
    expect(await deviceCount()).toBe(before + 1);
    const [row] = await app.db.db.select().from(devices).where(eq(devices.id, ok.json.deviceId));
    expect(row?.helperPublicKey).toBe(hk.publicKey);
    expect(row?.helperLastSignedTs).toBeNull();
    // Rad etilgan urinishlar audit qilinadi.
    const failed = (await app.db.db.select().from(auditEvents)).filter(
      (a) => a.action === 'device.claim' && a.result === 'failed',
    );
    expect(failed.map((a) => (a.details as { reason: string }).reason)).toEqual([
      'invalid_helper_proof',
      'invalid_helper_proof',
    ]);

    // Yangi qurilmaning helper kaliti darhol ishlaydi, Companion kaliti helper yo'liga yaramaydi.
    expect((await helperRequest(app, hk, ok.json.deviceId, 'GET', LOCK_STATE, undefined, ++now)).status).toBe(200);
    expect((await deviceRequest(app, key, ok.json.deviceId, 'GET', LOCK_STATE, undefined, ++now)).status).toBe(401);
  });

  test('helper key and proof come together or not at all', async () => {
    const token = await createToken();
    const key = makeDeviceKey();
    const hk = makeDeviceKey();
    const full = helperClaim(token, hk);
    expect((await claim(token, key, { helperPublicKey: full.helperPublicKey })).status).toBe(400);
    expect((await claim(token, key, { helperProof: full.helperProof })).status).toBe(400);
    expect(await deviceCount()).toBe(1); // faqat seedlangan qurilma
    // Ikkalasi ham yo'q: eski (helper'siz) claim ishlayveradi.
    const plain = await claim(token, key, {});
    expect(plain.status).toBe(201);
    const [row] = await app.db.db.select().from(devices).where(eq(devices.id, plain.json.deviceId));
    expect(row?.helperPublicKey).toBeNull();
  });

  test('helper key must be a canonical ed25519 key distinct from the companion key', async () => {
    const token = await createToken();
    const key = makeDeviceKey();
    // Companion kaliti bilan bir xil kalit ikki kalitni ajratish ma'nosini yo'qotadi.
    expect((await claim(token, key, helperClaim(token, key))).status).toBe(400);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
    const bad = await claim(token, key, { helperPublicKey: rsa.toString('base64url'), helperProof: 'AAAA' });
    expect(bad.status).toBe(400);
    expect(await deviceCount()).toBe(1);
  });

  test('a helper key already enrolled on another device is a conflict', async () => {
    const first = await createToken();
    const second = await createToken();
    const hk = makeDeviceKey();
    expect((await claim(first, makeDeviceKey(), helperClaim(first, hk))).status).toBe(201);
    const again = await claim(second, makeDeviceKey(), helperClaim(second, hk));
    expect(again.status).toBe(409);
    // Tranzaksiya qaytdi: ikkinchi token sarflanmadi.
    expect((await claim(second, makeDeviceKey(), {})).status).toBe(201);
  });
});

describe('helper enforcement level', () => {
  const DEVICES = () => `/api/v1/rooms/${roomId}/devices`;
  const windowsReport = (overlay: Record<string, unknown>) => ({
    protocolVersion: 1,
    os: 'windows',
    architecture: 'x64',
    desktopSession: 'windows',
    capabilities: { 'classroom.message': { state: 'available' }, 'classroom.overlay': overlay },
  });
  const active = { ...status, processGuard: 'active' };
  // Panel ko'radigan capability'lar: javob web panel ishlatadigan shartnoma sxemasidan o'tishi shart.
  const capabilities = async () => {
    const res = await app.request('GET', DEVICES(), { cookie: teacher });
    expect(res.status).toBe(200);
    expect(z.object({ devices: z.array(deviceSchema) }).safeParse(res.json).success).toBe(true);
    const device = res.json.devices.find((d: { id: string }) => d.id === deviceId);
    return device.capabilities.capabilities as Record<string, Record<string, unknown>>;
  };
  const reportHelper = async (body: unknown) => expect((await asHelper('PUT', STATUS, body)).status).toBe(204);

  test('overlay is hard only when the helper reports every component active', async () => {
    // Companion o'zi soft desa ham, yangi helper hisobotida hammasi active bo'lsa — hard.
    expect(
      (await asCompanion('PUT', CAPABILITIES, windowsReport({ state: 'available', enforcement: 'soft' }))).status,
    ).toBe(204);
    await reportHelper(active);
    expect((await capabilities())['classroom.overlay']).toEqual({ state: 'available', enforcement: 'hard' });

    // Birinchi yiqilgan komponent sabab bo'ladi (hook → policy → processGuard).
    await reportHelper({ ...active, processGuard: 'failed' });
    expect((await capabilities())['classroom.overlay']).toEqual({
      state: 'available',
      enforcement: 'soft',
      reason: 'process_guard_failed',
    });
    await reportHelper({ ...active, policy: 'failed', processGuard: 'failed' });
    expect((await capabilities())['classroom.overlay']).toMatchObject({ enforcement: 'soft', reason: 'policy_failed' });
    await reportHelper({ ...active, hook: 'failed', policy: 'failed' });
    expect((await capabilities())['classroom.overlay']).toMatchObject({ enforcement: 'soft', reason: 'hook_failed' });
    // Bloklash yo'q (komponentlar off): hard isbotlanmagan, lekin yiqilgan komponent ham yo'q.
    await reportHelper({ ...active, hook: 'off', policy: 'off', processGuard: 'off' });
    expect((await capabilities())['classroom.overlay']).toEqual({
      state: 'available',
      enforcement: 'soft',
      reason: 'lock_inactive',
    });
    // Saqlangan Companion hisoboti o'zgarmaydi: daraja faqat o'qishda hisoblanadi.
    const [stored] = await app.db.db.select().from(deviceCapabilities).where(eq(deviceCapabilities.deviceId, deviceId));
    expect(
      (stored?.report as { capabilities: Record<string, unknown> } | undefined)?.capabilities['classroom.overlay'],
    ).toEqual({
      state: 'available',
      enforcement: 'soft',
    });
  });

  test('a stale helper status falls back to soft', async () => {
    // Companion hard da'vo qilsa ham, helper hisobotisiz hard ko'rsatilmaydi.
    expect(
      (await asCompanion('PUT', CAPABILITIES, windowsReport({ state: 'available', enforcement: 'hard' }))).status,
    ).toBe(204);
    expect((await capabilities())['classroom.overlay']).toEqual({
      state: 'available',
      enforcement: 'soft',
      reason: 'helper_missing',
    });
    await reportHelper(active);
    const reportedAt = now;
    expect((await capabilities())['classroom.overlay']).toEqual({ state: 'available', enforcement: 'hard' });
    // 90 s chegarasi ichida hali yangi.
    now = reportedAt + 90_000;
    expect((await capabilities())['classroom.overlay']).toMatchObject({ enforcement: 'hard' });
    now = reportedAt + 90_001;
    expect((await capabilities())['classroom.overlay']).toEqual({
      state: 'available',
      enforcement: 'soft',
      reason: 'helper_missing',
    });
    // Companion o'zi soft desa, uning sababi saqlanadi.
    expect(
      (
        await asCompanion(
          'PUT',
          CAPABILITIES,
          windowsReport({ state: 'available', enforcement: 'soft', reason: 'hook_unavailable' }),
        )
      ).status,
    ).toBe(204);
    expect((await capabilities())['classroom.overlay']).toEqual({
      state: 'available',
      enforcement: 'soft',
      reason: 'hook_unavailable',
    });
  });

  test('sas_block reports the edition limit', async () => {
    expect(
      (await asCompanion('PUT', CAPABILITIES, windowsReport({ state: 'available', enforcement: 'soft' }))).status,
    ).toBe(204);
    // Helper hech qachon hisobot bermagan Windows qurilmasi.
    expect((await capabilities())['classroom.sas_block']).toEqual({ state: 'unsupported', reason: 'helper_missing' });
    const cases: [string, Record<string, unknown>][] = [
      ['blocked', { state: 'available' }],
      ['off', { state: 'available' }],
      ['unavailable', { state: 'unsupported', reason: 'edition' }],
      ['failed', { state: 'unsupported', reason: 'failed' }],
    ];
    for (const [cad, expected] of cases) {
      await reportHelper({ ...active, cad });
      expect((await capabilities())['classroom.sas_block'], `cad=${cad}`).toEqual(expected);
    }
    // Eski hisobot: imkoniyat tasdiqlanmagan.
    now += 90_001;
    expect((await capabilities())['classroom.sas_block']).toEqual({ state: 'unsupported', reason: 'helper_missing' });
  });

  test('non-windows devices get no sas_block', async () => {
    const report = {
      protocolVersion: 1,
      os: 'macos',
      architecture: 'arm64',
      desktopSession: 'macos',
      capabilities: {
        'classroom.overlay': { state: 'available', enforcement: 'soft' },
        // Companion bu kalitni o'zi da'vo qila olmaydi.
        'classroom.sas_block': { state: 'available' },
      },
    };
    expect((await asCompanion('PUT', CAPABILITIES, report)).status).toBe(204);
    const caps = await capabilities();
    expect(caps['classroom.sas_block']).toBeUndefined();
    expect(caps['classroom.overlay']).toEqual({ state: 'available', enforcement: 'soft' });
  });
});
