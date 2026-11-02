import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { HelpRequestsModule } from '../help-requests/help-requests.module.ts';
import { LessonsController } from './lessons.controller.ts';
import { LessonsService } from './lessons.service.ts';

@Module({
  imports: [HelpRequestsModule],
  controllers: [LessonsController],
  providers: [Access, LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
