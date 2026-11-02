import { createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, test } from 'vitest';
// Hub'ning o'z tekshiruv kodi: Companion imzosi server qabul qiladigan formatda ekanini mustaqil isbotlaydi.
import {
  deviceSigningInput,
  parseDevicePublicKey,
  verifyClaimProof,
  verifySignature,
} from '../../api/src/modules/devices/device-keys.ts';
import { claimProof, type DeviceIdentity, generateDeviceKey, RequestSigner } from '../src/core/identity.ts';

const DEVICE_ID = '7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a';
const TOKEN = `nse_${'A'.repeat(43)}`;

function identity(): DeviceIdentity {
  const { publicKey, privateKeyPem } = generateDeviceKey();
  return { deviceId: DEVICE_ID, publicKey, privateKey: createPrivateKey(privateKeyPem) };
}

describe('device identity', () => {
  test("claim proof verifies with the hub's verifyClaimProof", () => {
    const id = identity();
    const key = parseDevicePublicKey(id.publicKey);
    if (!key) throw new Error('hub rejected the public key');
    const proof = claimProof(id.privateKey, TOKEN, id.publicKey);
    expect(verifyClaimProof(key, TOKEN, id.publicKey, proof)).toBe(true);
    // Proof boshqa tokenga o'tkazilmaydi.
    expect(verifyClaimProof(key, `nse_${'B'.repeat(43)}`, id.publicKey, proof)).toBe(false);
  });

  test("request signature verifies with the hub's deviceSigningInput", () => {
    const id = identity();
    const key = parseDevicePublicKey(id.publicKey);
    if (!key) throw new Error('hub rejected the public key');
    const signer = new RequestSigner(id, () => 1_800_000_000_000);
    const body = Buffer.from('{"a":1}');
    const headers = signer.sign('POST', '/api/v1/device/heartbeat?x=1', body);
    expect(headers['x-ns-device-id']).toBe(DEVICE_ID);
    expect(headers['x-ns-timestamp']).toBe('1800000000000');
    const ts = headers['x-ns-timestamp'];
    const signature = headers['x-ns-signature'];
    expect(verifySignature(key, deviceSigningInput('POST', '/api/v1/device/heartbeat?x=1', ts, body), signature)).toBe(
      true,
    );
    // Yo'l, metod yoki body o'zgarsa imzo yaroqsiz.
    expect(verifySignature(key, deviceSigningInput('POST', '/api/v1/device/heartbeat', ts, body), signature)).toBe(
      false,
    );
    expect(verifySignature(key, deviceSigningInput('PUT', '/api/v1/device/heartbeat?x=1', ts, body), signature)).toBe(
      false,
    );
    expect(
      verifySignature(
        key,
        deviceSigningInput('POST', '/api/v1/device/heartbeat?x=1', ts, Buffer.from('{}')),
        signature,
      ),
    ).toBe(false);
  });

  test('public key is canonical SPKI the hub accepts', () => {
    const id = identity();
    const key = parseDevicePublicKey(id.publicKey);
    expect(key).not.toBeNull();
    expect(key?.asymmetricKeyType).toBe('ed25519');
    // Private kalitdan chiqarilgan public kalit bilan bir xil.
    expect(createPublicKey(id.privateKey).export({ type: 'spki', format: 'der' }).toString('base64url')).toBe(
      id.publicKey,
    );
  });

  test('signed timestamps strictly increase within one millisecond', () => {
    const signer = new RequestSigner(identity(), () => 1_000);
    const stamps = [0, 1, 2].map((): number => Number(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']));
    expect(stamps).toEqual([1_000, 1_001, 1_002]);
  });

  test('syncClock adopts the hub time only when the skew exceeds five seconds', () => {
    const signer = new RequestSigner(identity(), () => 1_000_000);
    signer.syncClock(1_000_000 + 120_000);
    expect(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('1120000');
    // Soat to'g'rilangach (farq ≤ 5 s) eski offset qolmaydi va imzo yana qurilma soatidan boshlanadi.
    signer.syncClock(1_000_000 + 4_000);
    expect(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('1000000');
    const fresh = new RequestSigner(identity(), () => 1_000_000);
    fresh.syncClock(1_000_000 - 60_000);
    expect(fresh.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('940000');
  });

  test('a fast device clock recovers: syncClock pulls the next timestamp back into the hub window', () => {
    // Qurilma soati 2 daqiqa oldinda: birinchi imzo hub oynasidan tashqarida.
    const signer = new RequestSigner(identity(), () => 1_000_000 + 120_000);
    expect(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('1120000');
    signer.syncClock(1_000_000);
    // Hub bu kelajakdagi qiymatni qabul qilmagan (±30 s), shuning uchun keyingisi hub vaqtiga qaytadi.
    expect(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('1000000');
    expect(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('1000001');
  });

  test('clock offset shifts signed timestamps', () => {
    let now = 5_000;
    const signer = new RequestSigner(identity(), () => now);
    signer.setClockOffset(120_000);
    expect(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('125000');
    signer.setClockOffset(-2_000);
    now = 200_000;
    expect(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('198000');
    // Offset kamaysa ham timestamp orqaga ketmaydi (hub `ts > last_signed_ts` talab qiladi).
    signer.setClockOffset(-100_000);
    expect(signer.sign('GET', '/x', Buffer.alloc(0))['x-ns-timestamp']).toBe('198001');
  });
});
