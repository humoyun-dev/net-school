import { createPublicKey } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import { DB, type Db } from '../../db/client.ts';
import { devices } from '../../db/schema.ts';
import { deviceSigningInput, verifySignature } from './device-keys.ts';

export const SIGNATURE_WINDOW_MS = 30_000;

export interface AuthenticatedDevice {
  id: string;
  organizationId: string;
  siteId: string;
}

// Imzolovchi: Companion (qurilma kaliti) yoki OS helper (alohida helper kaliti). Har birining o'z replay hisoblagichi bor.
export type DeviceSigner = 'companion' | 'helper';

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function helperKeyDer(stored: string | null): Buffer | null {
  return stored === null ? null : Buffer.from(stored, 'base64url');
}

// `x-ns-signer` sarlavhasi imzo kiritmasiga kirmaydi, faqat qaysi kalit bilan tekshirilishini bildiradi:
// yo'q yoki 'companion' — Companion, 'helper' — OS helper. Boshqa har qanday qiymat noma'lum (null).
function claimedSigner(headers: IncomingHttpHeaders): DeviceSigner | null {
  const value = header(headers, 'x-ns-signer');
  if (value === undefined || value === 'companion') return 'companion';
  return value === 'helper' ? 'helper' : null;
}

// Qurilma imzosi qoidasi (ADR 0005): HTTP guard va WS upgrade bitta joydan o'tadi.
// Ed25519 imzo + ±30 s oyna + monoton timestamp (replay himoyasi). Har xato — bir xil 'unauthenticated'.
// Marshrut qaysi imzolovchini talab qilishini `signer` aytadi; sarlavhadagi imzolovchi unga teng bo'lishi shart,
// shuning uchun Companion imzosi helper yo'lida va aksincha o'tmaydi.
@Injectable()
export class DeviceVerifier {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async verify(
    method: string,
    pathWithQuery: string,
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
    signer: DeviceSigner,
  ): Promise<AuthenticatedDevice> {
    if (claimedSigner(headers) !== signer) throw new ApiError('unauthenticated');
    const deviceId = header(headers, 'x-ns-device-id');
    const timestamp = header(headers, 'x-ns-timestamp');
    const signature = header(headers, 'x-ns-signature');
    if (!deviceId || !isUuid(deviceId) || !timestamp || !/^\d{1,16}$/.test(timestamp) || !signature) {
      throw new ApiError('unauthenticated');
    }
    const ts = Number(timestamp);
    if (Math.abs(this.now() - ts) > SIGNATURE_WINDOW_MS) throw new ApiError('unauthenticated');

    const [device] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), isNull(devices.retiredAt)));
    if (!device) throw new ApiError('unauthenticated');
    // Helper kaliti bo'lmagan qurilmada helper imzosi qabul qilinmaydi.
    const keyDer = signer === 'helper' ? helperKeyDer(device.helperPublicKey) : device.publicKey;
    if (!keyDer) throw new ApiError('unauthenticated');
    const key = createPublicKey({ key: keyDer, format: 'der', type: 'spki' });
    const input = deviceSigningInput(method, pathWithQuery, timestamp, rawBody);
    if (!verifySignature(key, input, signature)) throw new ApiError('unauthenticated');

    // Imzo to'g'ri bo'lgandan keyingina holat o'zgaradi; parallel replay'dan faqat bittasi o'tadi.
    // Hisoblagich imzolovchiga xos: Companion va helper timestamp'lari bir-biriga xalaqit bermaydi.
    const counter = signer === 'helper' ? devices.helperLastSignedTs : devices.lastSignedTs;
    const accepted = await this.db
      .update(devices)
      .set(signer === 'helper' ? { helperLastSignedTs: ts } : { lastSignedTs: ts })
      .where(and(eq(devices.id, device.id), isNull(devices.retiredAt), or(isNull(counter), lt(counter, ts))))
      .returning({ id: devices.id });
    if (accepted.length !== 1) throw new ApiError('unauthenticated');

    return { id: device.id, organizationId: device.organizationId, siteId: device.siteId };
  }
}
