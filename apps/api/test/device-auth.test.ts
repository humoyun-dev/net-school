import { generateKeyPairSync } from 'node:crypto';
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DeviceRoute } from '../src/common/route-flags.ts';
import { devices } from '../src/db/schema.ts';
import { authenticatedDevice, DeviceAuthGuard } from '../src/modules/devices/device-auth.guard.ts';
import { parseDevicePublicKey, verifyClaimProof } from '../src/modules/devices/device-keys.ts';
import { startTestApp, type TestApp } from './support/app.ts';
import { deviceRequest, makeDeviceKey, seedDevice, signingInput } from './support/device.ts';
import { loginAs } from './support/login.ts';
import { seedOrg, seedUser } from './support/seed.ts';

@Controller('api/v1/device')
@DeviceRoute()
@UseGuards(DeviceAuthGuard)
class EchoController {
  @Post('echo')
  echo(@Req() req: Request, @Body() body: unknown) {
    return { device: authenticatedDevice(req), body };
  }
}

const now = 1_800_000_000_000;
let app: TestApp;
let orgId: string;
let siteId: string;

beforeAll(async () => {
  app = await startTestApp({ controllers: [EchoController], now: () => now });
});
beforeEach(async () => {
  await app.db.reset();
  ({ orgId, siteId } = await seedOrg(app.db.db));
});
afterAll(async () => {
  await app?.close();
});

async function enrolled() {
  const key = makeDeviceKey();
  const id = await seedDevice(app.db.db, orgId, siteId, key.publicKey);
  return { key, id };
}

describe('device keys', () => {
  test('rsa and malformed keys are refused', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
    expect(parseDevicePublicKey(rsa.toString('base64url'))).toBeNull();
    expect(parseDevicePublicKey('not-a-key')).toBeNull();
    const good = makeDeviceKey();
    expect(parseDevicePublicKey(good.publicKey)).not.toBeNull();
    // Kanonik bo'lmagan kodlash (oxirida ortiqcha bayt) qabul qilinmaydi.
    const padded = Buffer.concat([Buffer.from(good.publicKey, 'base64url'), Buffer.from([0])]);
    expect(parseDevicePublicKey(padded.toString('base64url'))).toBeNull();
  });

  test('claim proof binds token and public key', () => {
    const key = makeDeviceKey();
    const parsed = parseDevicePublicKey(key.publicKey);
    if (!parsed) throw new Error('key');
    const token = `nse_${'a'.repeat(43)}`;
    const proof = key.sign(`NSCLAIM1\n${token}\n${key.publicKey}`);
    expect(verifyClaimProof(parsed, token, key.publicKey, proof)).toBe(true);
    expect(verifyClaimProof(parsed, `nse_${'b'.repeat(43)}`, key.publicKey, proof)).toBe(false);
    expect(verifyClaimProof(parsed, token, key.publicKey, 'AAAA')).toBe(false);
  });
});

describe('signed device requests', () => {
  test('signed request is accepted', async () => {
    const { key, id } = await enrolled();
    const res = await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', { hello: 1 }, now);
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ device: { id, organizationId: orgId, siteId }, body: { hello: 1 } });
  });

  test('replayed timestamp is rejected', async () => {
    const { key, id } = await enrolled();
    expect((await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now)).status).toBe(201);
    const replay = await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now);
    expect(replay.status).toBe(401);
    expect(replay.json.error.code).toBe('unauthenticated');
    expect((await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now - 1)).status).toBe(401);
    expect((await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now + 1)).status).toBe(201);
  });

  test('timestamp outside 30s window is rejected', async () => {
    const { key, id } = await enrolled();
    expect((await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now - 30_001)).status).toBe(401);
    expect((await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now + 30_001)).status).toBe(401);
    expect((await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now - 30_000)).status).toBe(201);
  });

  test('signature by another device key is rejected', async () => {
    const a = await enrolled();
    const b = await enrolled();
    expect((await deviceRequest(app, b.key, a.id, 'POST', '/api/v1/device/echo', {}, now)).status).toBe(401);
    // Rad etilgan so'rov holatni o'zgartirmaydi: haqiqiy qurilma shu timestamp bilan o'ta oladi.
    expect((await deviceRequest(app, a.key, a.id, 'POST', '/api/v1/device/echo', {}, now)).status).toBe(201);
  });

  test('tampered body is rejected', async () => {
    const { key, id } = await enrolled();
    const path = '/api/v1/device/echo';
    const res = await app.request('POST', path, {
      body: { hello: 2 },
      origin: null,
      headers: {
        'x-ns-device-id': id,
        'x-ns-timestamp': String(now),
        'x-ns-signature': key.sign(signingInput('POST', path, now, JSON.stringify({ hello: 1 }))),
      },
    });
    expect(res.status).toBe(401);
  });

  test('unknown device and malformed headers are rejected', async () => {
    const { key } = await enrolled();
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await deviceRequest(app, key, unknown, 'POST', '/api/v1/device/echo', {}, now)).status).toBe(401);
    expect((await deviceRequest(app, key, 'not-a-uuid', 'POST', '/api/v1/device/echo', {}, now)).status).toBe(401);
    expect((await app.request('POST', '/api/v1/device/echo', { body: {}, origin: null })).status).toBe(401);
  });

  test('retired device is rejected', async () => {
    const { key, id } = await enrolled();
    await app.db.db
      .update(devices)
      .set({ retiredAt: new Date(now) })
      .where(eq(devices.id, id));
    expect((await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now)).status).toBe(401);
  });

  test('device route needs no Origin and ignores session cookies', async () => {
    await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
    const cookie = await loginAs(app, 'admin1');
    const res = await app.request('POST', '/api/v1/device/echo', { body: {}, cookie });
    expect(res.status).toBe(401);
    const { key, id } = await enrolled();
    expect((await deviceRequest(app, key, id, 'POST', '/api/v1/device/echo', {}, now)).status).toBe(201);
  });

  test('non-device route still requires Origin', async () => {
    const res = await app.request('POST', '/api/v1/auth/login', {
      body: { username: 'x', password: 'y' },
      origin: null,
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('scope_denied');
  });
});
