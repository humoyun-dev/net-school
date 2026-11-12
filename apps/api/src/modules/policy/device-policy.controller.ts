import { Body, Controller, Get, HttpCode, Inject, Put, Query, Req, UseGuards } from '@nestjs/common';
import { policyReceiptSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { correlationIdOf } from '../../common/correlation.ts';
import { requestContext } from '../../common/request-context.ts';
import { DeviceRoute } from '../../common/route-flags.ts';
import { parseBody } from '../../common/validation.ts';
import { authenticatedDevice, DeviceAuthGuard, HelperAuthGuard } from '../devices/device-auth.guard.ts';
import { parseSiteId } from './policy.service.ts';
import { PolicyDeliveryService } from './policy-delivery.service.ts';

// Companion: ikkala qatlam va receipt (qurilma kaliti).
@Controller('api/v1/device/policy')
@DeviceRoute()
@UseGuards(DeviceAuthGuard)
export class DevicePolicyController {
  constructor(@Inject(PolicyDeliveryService) private readonly delivery: PolicyDeliveryService) {}

  @Get()
  policy(@Req() req: Request) {
    return this.delivery.devicePolicy(authenticatedDevice(req));
  }

  @Put('receipt')
  @HttpCode(204)
  async receipt(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const receipt = parseBody(policyReceiptSchema, body);
    await this.delivery.recordReceipt(authenticatedDevice(req), 'companion', receipt, correlationIdOf(req));
  }
}

// Helper: faqat bazaviy qatlam (ADR 0014: helper kaliti faqat `/device/helper/*`da).
@Controller('api/v1/device/helper/policy')
@DeviceRoute()
@UseGuards(HelperAuthGuard)
export class HelperPolicyController {
  constructor(@Inject(PolicyDeliveryService) private readonly delivery: PolicyDeliveryService) {}

  @Get()
  policy(@Req() req: Request) {
    return this.delivery.helperPolicy(authenticatedDevice(req));
  }

  @Put('receipt')
  @HttpCode(204)
  async receipt(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const receipt = parseBody(policyReceiptSchema, body);
    await this.delivery.recordReceipt(authenticatedDevice(req), 'helper', receipt, correlationIdOf(req));
  }
}

// Panel: qurilmalar bo'yicha siyosat holati.
@Controller('api/v1/policies/status')
export class PolicyStatusController {
  constructor(@Inject(PolicyDeliveryService) private readonly delivery: PolicyDeliveryService) {}

  @Get()
  status(@Query('roomId') roomId: unknown, @Query('siteId') siteId: unknown, @Req() req: Request) {
    const room = typeof roomId === 'string' && roomId !== '' ? roomId : null;
    return this.delivery.status(requestContext(req), { roomId: room, siteId: room ? null : parseSiteId(siteId) });
  }
}
