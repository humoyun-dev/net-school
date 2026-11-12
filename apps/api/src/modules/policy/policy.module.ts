import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { DevicePolicyController, HelperPolicyController, PolicyStatusController } from './device-policy.controller.ts';
import { PolicyController } from './policy.controller.ts';
import { PolicyService } from './policy.service.ts';
import { PolicyDeliveryService } from './policy-delivery.service.ts';

@Module({
  controllers: [PolicyController, DevicePolicyController, HelperPolicyController, PolicyStatusController],
  providers: [Access, PolicyService, PolicyDeliveryService],
  exports: [PolicyService, PolicyDeliveryService],
})
export class PolicyModule {}
