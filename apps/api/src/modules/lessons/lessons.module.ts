import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { LessonsController } from './lessons.controller.ts';
import { LessonsService } from './lessons.service.ts';

@Module({ controllers: [LessonsController], providers: [Access, LessonsService], exports: [LessonsService] })
export class LessonsModule {}
