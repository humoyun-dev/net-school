import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { PowerController } from './power.controller.ts';
import { PowerService } from './power.service.ts';
import { PowerWorker } from './power.worker.ts';
import { PowerSchedulesController } from './power-schedules.controller.ts';
import { PowerSchedulesService } from './power-schedules.service.ts';

@Module({
  controllers: [PowerController, PowerSchedulesController],
  providers: [Access, PowerService, PowerSchedulesService, PowerWorker],
  exports: [PowerService, PowerWorker],
})
export class PowerModule {}
