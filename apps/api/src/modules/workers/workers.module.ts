import { Module } from '@nestjs/common';
import { LessonsModule } from '../lessons/lessons.module.ts';
import { RemoteSessionsModule } from '../remote-sessions/remote-sessions.module.ts';
import { MaintenanceWorker } from './maintenance.worker.ts';
import { OutboxWorker } from './outbox.worker.ts';

@Module({
  imports: [LessonsModule, RemoteSessionsModule],
  providers: [OutboxWorker, MaintenanceWorker],
  exports: [OutboxWorker, MaintenanceWorker],
})
export class WorkersModule {}
