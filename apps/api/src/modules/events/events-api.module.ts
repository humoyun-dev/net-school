import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { CommandsModule } from '../commands/commands.module.ts';
import { LessonsModule } from '../lessons/lessons.module.ts';
import { RemoteSessionsModule } from '../remote-sessions/remote-sessions.module.ts';
import { EventsController } from './events.controller.ts';
import { EventsService } from './events.service.ts';

// Global EventsModule'dan alohida: lessons/commands/remote-sessions modullariga bog'liq, sikl bo'lmasligi uchun.
@Module({
  imports: [LessonsModule, CommandsModule, RemoteSessionsModule],
  controllers: [EventsController],
  providers: [Access, EventsService],
})
export class EventsApiModule {}
