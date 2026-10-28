import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { LoginThrottle } from '../identity/login-throttle.ts';
import { DeviceAuthGuard } from './device-auth.guard.ts';
import { DeviceChannelController } from './device-channel.controller.ts';
import { DevicesController } from './devices.controller.ts';
import { DevicesService } from './devices.service.ts';
import { EnrollmentsController } from './enrollments.controller.ts';
import { CLAIM_THROTTLE, EnrollmentsService } from './enrollments.service.ts';
import { MeshBindingController } from './mesh-binding.controller.ts';
import { MeshBindingService } from './mesh-binding.service.ts';
import { PresenceService } from './presence.service.ts';

@Module({
  controllers: [EnrollmentsController, DeviceChannelController, DevicesController, MeshBindingController],
  providers: [
    Access,
    DeviceAuthGuard,
    EnrollmentsService,
    PresenceService,
    DevicesService,
    MeshBindingService,
    // Claim IP cheklovi login cheklovidan alohida hisoblanadi.
    { provide: CLAIM_THROTTLE, useFactory: (now: Clock) => new LoginThrottle(now), inject: [CLOCK] },
  ],
})
export class DevicesModule {}
