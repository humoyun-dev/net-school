import { Module } from '@nestjs/common';
import { LessonsModule } from '../lessons/lessons.module.ts';
import { MaintenanceWorker } from './maintenance.worker.ts';
import { OutboxWorker } from './outbox.worker.ts';

@Module({
  imports: [LessonsModule],
  providers: [OutboxWorker, MaintenanceWorker],
  exports: [OutboxWorker, MaintenanceWorker],
})
export class WorkersModule {}
