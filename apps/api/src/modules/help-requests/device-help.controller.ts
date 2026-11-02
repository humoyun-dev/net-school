import { Body, Controller, Delete, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { deviceHelpRequestBodySchema } from '@netschool/contracts';
import type { Request } from 'express';
import { DeviceRoute } from '../../common/route-flags.ts';
import { parseBody } from '../../common/validation.ts';
import { authenticatedDevice, DeviceAuthGuard } from '../devices/device-auth.guard.ts';
import { HelpRequestsService } from './help-requests.service.ts';

// Qurilmaning qo'l ko'tarishi: har so'rov imzolangan.
@Controller('api/v1/device/help-request')
@DeviceRoute()
@UseGuards(DeviceAuthGuard)
export class DeviceHelpController {
  constructor(@Inject(HelpRequestsService) private readonly help: HelpRequestsService) {}

  @Post()
  @HttpCode(200)
  raise(@Body() body: unknown, @Req() req: Request) {
    parseBody(deviceHelpRequestBodySchema, body);
    return this.help.raise(authenticatedDevice(req));
  }

  @Delete()
  @HttpCode(204)
  async withdraw(@Req() req: Request): Promise<void> {
    await this.help.withdraw(authenticatedDevice(req));
  }
}
