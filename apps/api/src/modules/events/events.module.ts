import { Global, Module } from '@nestjs/common';
import { EventLog, Outbox } from './event-log.ts';

@Global()
@Module({ providers: [EventLog, Outbox], exports: [EventLog, Outbox] })
export class EventsModule {}
