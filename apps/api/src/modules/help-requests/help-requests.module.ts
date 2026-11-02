import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { DeviceAuthGuard } from '../devices/device-auth.guard.ts';
import { DeviceHelpController } from './device-help.controller.ts';
import { HelpRequestsController } from './help-requests.controller.ts';
import { HelpRequestsService } from './help-requests.service.ts';

@Module({
  controllers: [HelpRequestsController, DeviceHelpController],
  providers: [Access, HelpRequestsService, DeviceAuthGuard],
  exports: [HelpRequestsService],
})
export class HelpRequestsModule {}
