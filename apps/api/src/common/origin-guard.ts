import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { API_CONFIG, type ApiConfig } from '../config/config.ts';
import { ApiError } from './errors.ts';

const SAFE = new Set(['GET', 'HEAD']);

// CSRF: o'zgartiruvchi har so'rov faqat o'z origin'imizdan.
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (req.headers.origin !== this.config.publicOrigin) throw new ApiError('scope_denied');
    return true;
  }
}
