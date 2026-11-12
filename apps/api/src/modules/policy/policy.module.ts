import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { PolicyController } from './policy.controller.ts';
import { PolicyService } from './policy.service.ts';

@Module({
  controllers: [PolicyController],
  providers: [Access, PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
