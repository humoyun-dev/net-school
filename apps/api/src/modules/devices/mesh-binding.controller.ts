import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { meshBindingRequestSchema, meshDomainRequestSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { MeshBindingService } from './mesh-binding.service.ts';

@Controller('api/v1')
export class MeshBindingController {
  constructor(@Inject(MeshBindingService) private readonly mesh: MeshBindingService) {}

  @Put('sites/:siteId/mesh-domain')
  configure(@Param('siteId') siteId: string, @Body() body: unknown, @Req() req: Request) {
    const { meshDomainId } = parseBody(meshDomainRequestSchema, body);
    return this.mesh.configureDomain(requestContext(req), siteId, meshDomainId);
  }

  @Get('sites/:siteId/mesh-nodes')
  async nodes(@Param('siteId') siteId: string, @Req() req: Request) {
    return { nodes: await this.mesh.nodes(requestContext(req), siteId) };
  }

  @Put('devices/:deviceId/mesh-binding')
  bind(@Param('deviceId') deviceId: string, @Body() body: unknown, @Req() req: Request) {
    const { meshNodeId } = parseBody(meshBindingRequestSchema, body);
    return this.mesh.bind(requestContext(req), deviceId, meshNodeId);
  }

  @Delete('devices/:deviceId/mesh-binding')
  @HttpCode(204)
  async unbind(@Param('deviceId') deviceId: string, @Req() req: Request): Promise<void> {
    await this.mesh.unbind(requestContext(req), deviceId);
  }
}
