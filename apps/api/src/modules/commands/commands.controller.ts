import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { issueCommandRequestSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { idempotencyKeyOf } from '../../common/idempotency.ts';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { CommandsService } from './commands.service.ts';

@Controller('api/v1')
export class CommandsController {
  constructor(@Inject(CommandsService) private readonly commands: CommandsService) {}

  // 202: qabul qilindi, qurilmada bajarildi degani emas (spec §9).
  @Post('lessons/:lessonId/commands')
  async issue(
    @Param('lessonId') lessonId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKeyOf(req);
    const input = parseBody(issueCommandRequestSchema, body);
    const result = await this.commands.issue(requestContext(req), lessonId, input, key);
    res.status(result.status);
    return result.body;
  }

  @Get('commands/:commandId')
  get(@Param('commandId') commandId: string, @Req() req: Request) {
    return this.commands.get(requestContext(req), commandId);
  }
}
