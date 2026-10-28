import { createPublicKey } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Request } from 'express';
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

const authenticated = new WeakMap<Request, AuthenticatedDevice>();

export function authenticatedDevice(req: Request): AuthenticatedDevice {
  const device = authenticated.get(req);
  if (!device) throw new ApiError('unauthenticated');
  return device;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

// Qurilma so'rovi: Ed25519 imzo + monoton timestamp (replay himoyasi). Har xato — bir xil 401.
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const deviceId = header(req, 'x-ns-device-id');
    const timestamp = header(req, 'x-ns-timestamp');
    const signature = header(req, 'x-ns-signature');
    if (!deviceId || !isUuid(deviceId) || !timestamp || !/^\d{1,16}$/.test(timestamp) || !signature) {
      throw new ApiError('unauthenticated');
    }
    const ts = Number(timestamp);
    if (Math.abs(this.now() - ts) > SIGNATURE_WINDOW_MS) throw new ApiError('unauthenticated');
    // JSON parser o'qimagan body imzoga kirmaydi — bunday so'rov qabul qilinmaydi.
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > 0 && !req.rawBody) throw new ApiError('unauthenticated');

    const [device] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), isNull(devices.retiredAt)));
    if (!device) throw new ApiError('unauthenticated');
    const key = createPublicKey({ key: device.publicKey, format: 'der', type: 'spki' });
    const input = deviceSigningInput(req.method, req.originalUrl, timestamp, req.rawBody ?? Buffer.alloc(0));
    if (!verifySignature(key, input, signature)) throw new ApiError('unauthenticated');

    // Imzo to'g'ri bo'lgandan keyingina holat o'zgaradi; parallel replay'dan faqat bittasi o'tadi.
    const accepted = await this.db
      .update(devices)
      .set({ lastSignedTs: ts })
      .where(
        and(
          eq(devices.id, device.id),
          isNull(devices.retiredAt),
          or(isNull(devices.lastSignedTs), lt(devices.lastSignedTs, ts)),
        ),
      )
      .returning({ id: devices.id });
    if (accepted.length !== 1) throw new ApiError('unauthenticated');

    authenticated.set(req, { id: device.id, organizationId: device.organizationId, siteId: device.siteId });
    return true;
  }
}
