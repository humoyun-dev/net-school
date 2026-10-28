import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { DeviceAuthGuard } from '../devices/device-auth.guard.ts';
import { LessonsModule } from '../lessons/lessons.module.ts';
import { CommandsController } from './commands.controller.ts';
import { CommandsService } from './commands.service.ts';
import { DeviceCommandsController } from './device-commands.controller.ts';
import { DeviceCommandsService } from './device-commands.service.ts';

@Module({
  imports: [LessonsModule],
  controllers: [CommandsController, DeviceCommandsController],
  providers: [Access, CommandsService, DeviceCommandsService, DeviceAuthGuard],
  exports: [CommandsService],
})
export class CommandsModule {}
