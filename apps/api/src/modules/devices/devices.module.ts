import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { HelpRequestsModule } from '../help-requests/help-requests.module.ts';
import { LoginThrottle } from '../identity/login-throttle.ts';
import { PolicyModule } from '../policy/policy.module.ts';
import { DeviceAuthGuard, HelperAuthGuard } from './device-auth.guard.ts';
import { DeviceChannelController } from './device-channel.controller.ts';
import { DevicesController } from './devices.controller.ts';
import { DevicesService } from './devices.service.ts';
import { EnrollmentsController } from './enrollments.controller.ts';
import { CLAIM_THROTTLE, EnrollmentsService } from './enrollments.service.ts';
import { HelperController } from './helper.controller.ts';
import { MeshBindingController } from './mesh-binding.controller.ts';
import { MeshBindingService } from './mesh-binding.service.ts';
import { PresenceService } from './presence.service.ts';

@Module({
  imports: [HelpRequestsModule, PolicyModule],
  controllers: [
    EnrollmentsController,
    DeviceChannelController,
    HelperController,
    DevicesController,
    MeshBindingController,
  ],
  providers: [
    Access,
    DeviceAuthGuard,
    HelperAuthGuard,
    EnrollmentsService,
    PresenceService,
    DevicesService,
    MeshBindingService,
    // Claim IP cheklovi login cheklovidan alohida hisoblanadi.
    { provide: CLAIM_THROTTLE, useFactory: (now: Clock) => new LoginThrottle(now), inject: [CLOCK] },
  ],
})
export class DevicesModule {}
