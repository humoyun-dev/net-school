import { Global, Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { AuditController } from './audit.controller.ts';
import { AuditWriter } from './audit.writer.ts';

@Global()
@Module({ controllers: [AuditController], providers: [AuditWriter, Access], exports: [AuditWriter] })
export class AuditModule {}
