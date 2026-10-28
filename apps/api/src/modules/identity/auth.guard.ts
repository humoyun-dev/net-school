import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from '../../common/errors.ts';
import { setAuthenticated } from '../../common/request-context.ts';
import { ALLOW_DURING_PASSWORD_CHANGE, DEVICE_ROUTE, PUBLIC_ROUTE } from '../../common/route-flags.ts';
import { DB, type Db } from '../../db/client.ts';
import { loadActor, type UserRow } from './actor.loader.ts';
import { readSessionCookie, SessionService } from './sessions.ts';

const users = new WeakMap<Request, UserRow>();

export function authenticatedUser(req: Request): UserRow {
  const user = users.get(req);
  if (!user) throw new ApiError('unauthenticated');
  return user;
}

// Global guard: @Public() yoki @DeviceRoute() bo'lmagan har marshrut tirik sessiya talab qiladi.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(DEVICE_ROUTE, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const session = await this.sessions.resolve(readSessionCookie(req.headers.cookie));
    if (!session) throw new ApiError('unauthenticated');
    const loaded = await loadActor(this.db, session.userId);
    if (!loaded || loaded.user.disabledAt) {
      await this.sessions.revoke(session.sessionId);
      throw new ApiError('unauthenticated');
    }
    if (
      loaded.user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_PASSWORD_CHANGE, targets)
    ) {
      throw new ApiError('password_change_required');
    }
    setAuthenticated(req, loaded.actor, session.sessionId);
    users.set(req, loaded.user);
    return true;
  }
}
