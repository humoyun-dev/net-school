import { Global, Module } from '@nestjs/common';
import { EventLog, Outbox } from './event-log.ts';
import { DEVICE_NOTIFIER, Notifier, ROOM_NOTIFIER } from './notifier.ts';

@Global()
@Module({
  providers: [
    EventLog,
    Outbox,
    { provide: DEVICE_NOTIFIER, useFactory: () => new Notifier() },
    { provide: ROOM_NOTIFIER, useFactory: () => new Notifier() },
  ],
  exports: [EventLog, Outbox, DEVICE_NOTIFIER, ROOM_NOTIFIER],
})
export class EventsModule {}
