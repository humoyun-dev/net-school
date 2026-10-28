import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { assignRoomRequestSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { DevicesService } from './devices.service.ts';

@Controller('api/v1')
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devices: DevicesService) {}

  @Get('rooms/:roomId/devices')
  async byRoom(@Param('roomId') roomId: string, @Req() req: Request) {
    return { devices: await this.devices.list(requestContext(req), { roomId }) };
  }

  @Get('sites/:siteId/devices')
  async bySite(@Param('siteId') siteId: string, @Req() req: Request) {
    return { devices: await this.devices.list(requestContext(req), { siteId }) };
  }

  @Put('devices/:deviceId/room')
  assignRoom(@Param('deviceId') deviceId: string, @Body() body: unknown, @Req() req: Request) {
    return this.devices.assignRoom(requestContext(req), deviceId, parseBody(assignRoomRequestSchema, body).roomId);
  }

  @Delete('devices/:deviceId')
  @HttpCode(204)
  async retire(@Param('deviceId') deviceId: string, @Req() req: Request): Promise<void> {
    await this.devices.retire(requestContext(req), deviceId);
  }
}
