import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { openRemoteSessionRequestSchema, renewRemoteSessionRequestSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { idempotencyKeyOf } from '../../common/idempotency.ts';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { RemoteSessionsService } from './remote-sessions.service.ts';

@Controller('api/v1')
export class RemoteSessionsController {
  constructor(@Inject(RemoteSessionsService) private readonly sessions: RemoteSessionsService) {}

  @Post('lessons/:lessonId/remote-sessions')
  async open(
    @Param('lessonId') lessonId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKeyOf(req);
    const input = parseBody(openRemoteSessionRequestSchema, body);
    const result = await this.sessions.open(requestContext(req), lessonId, input, key);
    res.status(result.status);
    return result.body;
  }

  // Bir martalik ticket URL'i hech qayerda keshlanmaydi.
  @Post('remote-sessions/:sessionId/ticket')
  @HttpCode(200)
  async ticket(@Param('sessionId') sessionId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('cache-control', 'no-store');
    return this.sessions.issueTicket(requestContext(req), sessionId);
  }

  @Get('remote-sessions/:sessionId')
  get(@Param('sessionId') sessionId: string, @Req() req: Request) {
    return this.sessions.get(requestContext(req), sessionId);
  }

  // Client har 10 s'da chaqiradi (lease 30 s).
  @Post('remote-sessions/:sessionId/renew')
  @HttpCode(200)
  renew(@Param('sessionId') sessionId: string, @Body() body: unknown, @Req() req: Request) {
    return this.sessions.renew(requestContext(req), sessionId, parseBody(renewRemoteSessionRequestSchema, body));
  }

  @Delete('remote-sessions/:sessionId')
  @HttpCode(204)
  async close(@Param('sessionId') sessionId: string, @Req() req: Request): Promise<void> {
    await this.sessions.close(requestContext(req), sessionId);
  }
}
