import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { DB, type Db } from '../../db/client.ts';
import { AuthController } from './auth.controller.ts';
import { AuthGuard } from './auth.guard.ts';
import { AuthService, LOGIN_THROTTLE } from './auth.service.ts';
import { LoginThrottle } from './login-throttle.ts';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SessionService } from './sessions.ts';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: SessionService,
      useFactory: (db: Db, now: Clock) =>
        new SessionService(db, { now, idleMs: SESSION_IDLE_MS, absoluteMs: SESSION_ABSOLUTE_MS }),
      inject: [DB, CLOCK],
    },
    { provide: LOGIN_THROTTLE, useFactory: (now: Clock) => new LoginThrottle(now), inject: [CLOCK] },
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService],
})
export class IdentityModule {}
