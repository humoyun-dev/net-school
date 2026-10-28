import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { loginRequestSchema, passwordChangeRequestSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { AllowDuringPasswordChange, Public } from '../../common/route-flags.ts';
import { parseBody } from '../../common/validation.ts';
import { userSummary } from './actor.loader.ts';
import { authenticatedUser } from './auth.guard.ts';
import { AuthService } from './auth.service.ts';
import { clearedSessionCookie, sessionCookie } from './sessions.ts';

@Controller('api/v1')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parseBody(loginRequestSchema, body);
    const ctx = requestContext(req);
    const result = await this.auth.login(input.username, input.password, ctx.clientIp, ctx.correlationId);
    res.setHeader('set-cookie', sessionCookie(result.token));
    res.setHeader('cache-control', 'no-store');
    return { user: result.user };
  }

  @AllowDuringPasswordChange()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const ctx = requestContext(req);
    if (ctx.sessionId) await this.auth.logout(authenticatedUser(req), ctx.sessionId, ctx.correlationId);
    res.setHeader('set-cookie', clearedSessionCookie());
  }

  @AllowDuringPasswordChange()
  @Post('auth/password')
  @HttpCode(204)
  async changePassword(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const input = parseBody(passwordChangeRequestSchema, body);
    const ctx = requestContext(req);
    await this.auth.changePassword(
      authenticatedUser(req),
      ctx.sessionId ?? '',
      input.currentPassword,
      input.newPassword,
      ctx.correlationId,
    );
  }

  @AllowDuringPasswordChange()
  @Get('me')
  me(@Req() req: Request) {
    const user = authenticatedUser(req);
    const { actor } = requestContext(req);
    return {
      user: userSummary(user),
      organizationId: user.organizationId,
      assignments: (actor?.assignments ?? []).map((a) => ({ role: a.role, siteId: a.siteId })),
      roomIds: actor?.roomIds ?? [],
    };
  }
}
