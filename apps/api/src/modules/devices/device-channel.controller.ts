import { Body, Controller, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import { capabilityReportSchema, heartbeatRequestSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { correlationIdOf } from '../../common/correlation.ts';
import { DeviceRoute } from '../../common/route-flags.ts';
import { parseBody } from '../../common/validation.ts';
import { authenticatedDevice, DeviceAuthGuard } from './device-auth.guard.ts';
import { PresenceService } from './presence.service.ts';

// Qurilmaning o'zi chaqiradigan marshrutlar: har so'rov imzolangan.
@Controller('api/v1/device')
@DeviceRoute()
@UseGuards(DeviceAuthGuard)
export class DeviceChannelController {
  constructor(@Inject(PresenceService) private readonly presence: PresenceService) {}

  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(@Body() body: unknown, @Req() req: Request) {
    parseBody(heartbeatRequestSchema, body);
    return this.presence.heartbeat(authenticatedDevice(req));
  }

  @Put('capabilities')
  @HttpCode(204)
  async capabilities(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const report = parseBody(capabilityReportSchema, body);
    await this.presence.reportCapabilities(authenticatedDevice(req), report, correlationIdOf(req));
  }
}
