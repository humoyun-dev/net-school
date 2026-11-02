import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { PowerController } from './power.controller.ts';
import { PowerService } from './power.service.ts';
import { PowerWorker } from './power.worker.ts';

@Module({
  controllers: [PowerController],
  providers: [Access, PowerService, PowerWorker],
  exports: [PowerService, PowerWorker],
})
export class PowerModule {}
