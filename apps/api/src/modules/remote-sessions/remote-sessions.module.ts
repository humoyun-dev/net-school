import { Module } from '@nestjs/common';
import { RemoteGateway } from './remote-gateway.ts';

@Module({ providers: [RemoteGateway], exports: [RemoteGateway] })
export class RemoteSessionsModule {}
