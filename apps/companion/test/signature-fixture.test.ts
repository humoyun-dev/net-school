import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { deviceSigningInput, verifySignature } from '../../api/src/modules/devices/device-keys.ts';
import { RequestSigner } from '../src/core/identity.ts';

// TS ↔ Go imzo vektorlari. Fixture'ni Go helper (native/helper/internal/hub/signer_test.go) ham o'qiydi:
// Companion imzosi o'zgarsa bu test yiqiladi va Go tomoni jim buzilib qolmaydi.
interface Vector {
  name: string;
  privateKeyPem: string;
  deviceId: string;
  method: string;
  pathWithQuery: string;
  timestamp: number;
  bodyBase64: string;
  expectedSignature: string;
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'packages', 'contracts', 'fixtures', 'device-signature.json'),
    'utf8',
  ),
) as { vectors: Vector[] };

describe('device signature fixture', () => {
  test('covers an empty-body GET, a PUT with a body and a path with a query', () => {
    const vectors = fixture.vectors;
    expect(vectors.some((v) => v.method === 'GET' && v.bodyBase64 === '')).toBe(true);
    expect(vectors.some((v) => v.method === 'PUT' && v.bodyBase64 !== '')).toBe(true);
    expect(vectors.some((v) => v.pathWithQuery.includes('?'))).toBe(true);
  });

  test.each(fixture.vectors.map((v) => [v.name, v] as const))(
    '%s: RequestSigner reproduces expectedSignature',
    (_name, v) => {
      const privateKey = createPrivateKey(v.privateKeyPem);
      const publicKey = createPublicKey(privateKey);
      const signer = new RequestSigner(
        {
          deviceId: v.deviceId,
          publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
          privateKey,
        },
        () => v.timestamp,
      );
      const body = Buffer.from(v.bodyBase64, 'base64');
      const headers = signer.sign(v.method, v.pathWithQuery, body);
      expect(headers['x-ns-device-id']).toBe(v.deviceId);
      expect(headers['x-ns-timestamp']).toBe(String(v.timestamp));
      expect(headers['x-ns-signature']).toBe(v.expectedSignature);
      // Hub'ning o'z tekshiruvi ham shu vektorni qabul qiladi.
      expect(
        verifySignature(
          publicKey,
          deviceSigningInput(v.method, v.pathWithQuery, String(v.timestamp), body),
          v.expectedSignature,
        ),
      ).toBe(true);
    },
  );
});
