import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { RemoteGateway } from './remote-gateway.ts';
import { RemoteSessionsController } from './remote-sessions.controller.ts';
import { RemoteSessionsService } from './remote-sessions.service.ts';

@Module({
  controllers: [RemoteSessionsController],
  providers: [Access, RemoteGateway, RemoteSessionsService],
  exports: [RemoteGateway, RemoteSessionsService],
})
export class RemoteSessionsModule {}
