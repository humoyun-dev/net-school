import { Body, Controller, Get, HttpCode, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { helperStatusSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { DeviceRoute } from '../../common/route-flags.ts';
import { parseBody } from '../../common/validation.ts';
import { authenticatedDevice, HelperAuthGuard } from './device-auth.guard.ts';
import { PresenceService } from './presence.service.ts';

// OS helper (SYSTEM xizmati) marshrutlari: faqat helper kaliti bilan imzolangan so'rovlar (`x-ns-signer: helper`).
@Controller('api/v1/device/helper')
@DeviceRoute()
@UseGuards(HelperAuthGuard)
export class HelperController {
  constructor(@Inject(PresenceService) private readonly presence: PresenceService) {}

  // Heartbeat emas: lastHeartbeatAt'ga tegmaydi va hech narsa yaratmaydi.
  @Get('lock-state')
  lockState(@Req() req: Request) {
    return this.presence.lockStateOf(authenticatedDevice(req));
  }

  @Put('status')
  @HttpCode(204)
  async status(@Body() body: unknown, @Req() req: Request): Promise<void> {
    await this.presence.reportHelperStatus(authenticatedDevice(req), parseBody(helperStatusSchema, body));
  }
}
