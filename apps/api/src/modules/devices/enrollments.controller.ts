import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { claimRequestSchema, createEnrollmentRequestSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { DeviceRoute } from '../../common/route-flags.ts';
import { parseBody } from '../../common/validation.ts';
import { EnrollmentsService } from './enrollments.service.ts';

@Controller('api/v1')
export class EnrollmentsController {
  constructor(@Inject(EnrollmentsService) private readonly enrollments: EnrollmentsService) {}

  @Post('enrollments')
  create(@Body() body: unknown, @Req() req: Request) {
    return this.enrollments.create(requestContext(req), parseBody(createEnrollmentRequestSchema, body));
  }

  @Post('enrollments/claim')
  @DeviceRoute()
  claim(@Body() body: unknown, @Req() req: Request) {
    const ctx = requestContext(req);
    return this.enrollments.claim(parseBody(claimRequestSchema, body), ctx.clientIp, ctx.correlationId);
  }

  @Delete('enrollments/:enrollmentId')
  @HttpCode(204)
  async revoke(@Param('enrollmentId') enrollmentId: string, @Req() req: Request): Promise<void> {
    await this.enrollments.revoke(requestContext(req), enrollmentId);
  }

  @Get('sites/:siteId/enrollments')
  async list(@Param('siteId') siteId: string, @Req() req: Request) {
    return { enrollments: await this.enrollments.list(requestContext(req), siteId) };
  }
}
