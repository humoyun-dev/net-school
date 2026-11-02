import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../../common/errors.ts';
import { type AuthenticatedDevice, DeviceVerifier } from './device-verifier.ts';

export { type AuthenticatedDevice, SIGNATURE_WINDOW_MS } from './device-verifier.ts';

const authenticated = new WeakMap<Request, AuthenticatedDevice>();

export function authenticatedDevice(req: Request): AuthenticatedDevice {
  const device = authenticated.get(req);
  if (!device) throw new ApiError('unauthenticated');
  return device;
}

// Qurilma so'rovi: imzo qoidasi DeviceVerifier'da (WS upgrade ham shuni ishlatadi). Har xato — bir xil 401.
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(@Inject(DeviceVerifier) private readonly verifier: DeviceVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    // JSON parser o'qimagan body imzoga kirmaydi — bunday so'rov qabul qilinmaydi.
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > 0 && !req.rawBody) throw new ApiError('unauthenticated');
    const device = await this.verifier.verify(req.method, req.originalUrl, req.headers, req.rawBody ?? Buffer.alloc(0));
    authenticated.set(req, device);
    return true;
  }
}
