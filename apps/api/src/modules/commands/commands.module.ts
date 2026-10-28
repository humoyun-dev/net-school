import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { LessonsModule } from '../lessons/lessons.module.ts';
import { CommandsController } from './commands.controller.ts';
import { CommandsService } from './commands.service.ts';

@Module({
  imports: [LessonsModule],
  controllers: [CommandsController],
  providers: [Access, CommandsService],
  exports: [CommandsService],
})
export class CommandsModule {}
