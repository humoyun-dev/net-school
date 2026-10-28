import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { LoginThrottle } from '../identity/login-throttle.ts';
import { DeviceAuthGuard } from './device-auth.guard.ts';
import { EnrollmentsController } from './enrollments.controller.ts';
import { CLAIM_THROTTLE, EnrollmentsService } from './enrollments.service.ts';

@Module({
  controllers: [EnrollmentsController],
  providers: [
    Access,
    DeviceAuthGuard,
    EnrollmentsService,
    // Claim IP cheklovi login cheklovidan alohida hisoblanadi.
    { provide: CLAIM_THROTTLE, useFactory: (now: Clock) => new LoginThrottle(now), inject: [CLOCK] },
  ],
})
export class DevicesModule {}
