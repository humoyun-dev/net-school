import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { API_CONFIG, type ApiConfig } from '../config/config.ts';
import { ApiError } from './errors.ts';
import { DEVICE_ROUTE } from './route-flags.ts';

const SAFE = new Set(['GET', 'HEAD']);

// CSRF: o'zgartiruvchi har so'rov faqat o'z origin'imizdan. Qurilma marshrutlari cookie ishlatmaydi.
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(DEVICE_ROUTE, [context.getHandler(), context.getClass()]))
      return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (req.headers.origin !== this.config.publicOrigin) throw new ApiError('scope_denied');
    return true;
  }
}
