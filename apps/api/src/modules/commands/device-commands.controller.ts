import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { receiptRequestSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DeviceRoute } from '../../common/route-flags.ts';
import { parseBody } from '../../common/validation.ts';
import { authenticatedDevice, DeviceAuthGuard } from '../devices/device-auth.guard.ts';
import { DeviceCommandsService, MAX_WAIT_SECONDS } from './device-commands.service.ts';

const waitSchema = z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(0);

@Controller('api/v1/device/commands')
@DeviceRoute()
@UseGuards(DeviceAuthGuard)
export class DeviceCommandsController {
  constructor(@Inject(DeviceCommandsService) private readonly channel: DeviceCommandsService) {}

  @Get()
  async pull(@Query('wait') wait: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const seconds = parseBody(waitSchema, wait);
    // Mijoz uzilsa kutish to'xtaydi.
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    return { commands: await this.channel.pull(authenticatedDevice(req), seconds, abort.signal) };
  }

  @Post(':commandId/receipt')
  @HttpCode(204)
  async receipt(@Param('commandId') commandId: string, @Body() body: unknown, @Req() req: Request): Promise<void> {
    await this.channel.receipt(authenticatedDevice(req), commandId, parseBody(receiptRequestSchema, body));
  }
}
