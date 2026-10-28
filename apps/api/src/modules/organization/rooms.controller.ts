import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Put, Req } from '@nestjs/common';
import { updateRoomRequestSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { OrganizationService } from './organization.service.ts';

@Controller('api/v1/rooms')
export class RoomsController {
  constructor(@Inject(OrganizationService) private readonly org: OrganizationService) {}

  @Patch(':roomId')
  update(@Param('roomId') roomId: string, @Body() body: unknown, @Req() req: Request) {
    return this.org.updateRoom(requestContext(req), roomId, parseBody(updateRoomRequestSchema, body).name);
  }

  @Put(':roomId/teachers/:userId')
  @HttpCode(204)
  async assign(@Param('roomId') roomId: string, @Param('userId') userId: string, @Req() req: Request): Promise<void> {
    await this.org.setTeacher(requestContext(req), roomId, userId, true);
  }

  @Delete(':roomId/teachers/:userId')
  @HttpCode(204)
  async unassign(@Param('roomId') roomId: string, @Param('userId') userId: string, @Req() req: Request): Promise<void> {
    await this.org.setTeacher(requestContext(req), roomId, userId, false);
  }
}
