import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { createRoomRequestSchema, createSiteRequestSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { OrganizationService } from './organization.service.ts';

@Controller('api/v1/sites')
export class SitesController {
  constructor(@Inject(OrganizationService) private readonly org: OrganizationService) {}

  @Get()
  async list(@Req() req: Request) {
    return { sites: await this.org.listSites(requestContext(req)) };
  }

  @Post()
  create(@Body() body: unknown, @Req() req: Request) {
    return this.org.createSite(requestContext(req), parseBody(createSiteRequestSchema, body).name);
  }

  @Get(':siteId/rooms')
  async rooms(@Param('siteId') siteId: string, @Req() req: Request) {
    return { rooms: await this.org.listRooms(requestContext(req), siteId) };
  }

  @Post(':siteId/rooms')
  createRoom(@Param('siteId') siteId: string, @Body() body: unknown, @Req() req: Request) {
    return this.org.createRoom(requestContext(req), siteId, parseBody(createRoomRequestSchema, body).name);
  }
}
