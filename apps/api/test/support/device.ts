import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { Db } from '../../src/db/client.ts';
import { devices } from '../../src/db/schema.ts';
import type { TestApp, TestResponse } from './app.ts';

export interface DeviceKey {
  publicKey: string; // SPKI DER base64url
  sign(message: Buffer | string): string;
}

export function makeDeviceKey(): DeviceKey {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    sign: (message) => sign(null, Buffer.from(message), pair.privateKey).toString('base64url'),
  };
}

// Server bilan bir xil imzo kiritmasi; testda mustaqil yoziladi.
export function signingInput(method: string, path: string, timestamp: number, rawBody: string): string {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return `NSDEV1\n${method}\n${path}\n${timestamp}\n${bodyHash}`;
}

export function deviceRequest(
  app: TestApp,
  key: DeviceKey,
  deviceId: string,
  method: string,
  path: string,
  body?: unknown,
  timestamp: number = Date.now(),
): Promise<TestResponse> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  return app.request(method, path, {
    body,
    origin: null,
    headers: {
      'x-ns-device-id': deviceId,
      'x-ns-timestamp': String(timestamp),
      'x-ns-signature': key.sign(signingInput(method, path, timestamp, raw)),
    },
  });
}

// Claim Task 6'da; bu yerda qurilma to'g'ridan-to'g'ri yoziladi.
export async function seedDevice(
  db: Db,
  orgId: string,
  siteId: string,
  publicKey: string,
  opts: { roomId?: string; hostname?: string } = {},
): Promise<string> {
  const der = Buffer.from(publicKey, 'base64url');
  const [row] = await db
    .insert(devices)
    .values({
      organizationId: orgId,
      siteId,
      roomId: opts.roomId ?? null,
      hostname: opts.hostname ?? 'pc-01',
      publicKey: der,
      keyFingerprint: createHash('sha256').update(der).digest('hex'),
    })
    .returning();
  if (!row) throw new Error('seed device');
  return row.id;
}
