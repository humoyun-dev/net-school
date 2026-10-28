import { Module } from '@nestjs/common';
import { OutboxWorker } from './outbox.worker.ts';

@Module({ providers: [OutboxWorker], exports: [OutboxWorker] })
export class WorkersModule {}
