import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { startLessonRequestSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { idempotencyKeyOf } from '../../common/idempotency.ts';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { LessonsService } from './lessons.service.ts';

@Controller('api/v1')
export class LessonsController {
  constructor(@Inject(LessonsService) private readonly lessons: LessonsService) {}

  @Post('rooms/:roomId/lessons')
  async start(
    @Param('roomId') roomId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKeyOf(req);
    const result = await this.lessons.start(
      requestContext(req),
      roomId,
      parseBody(startLessonRequestSchema, body),
      key,
    );
    res.status(result.status);
    return result.body;
  }

  @Get('rooms/:roomId/lessons/active')
  async active(@Param('roomId') roomId: string, @Req() req: Request) {
    return { lesson: await this.lessons.active(requestContext(req), roomId) };
  }

  @Get('lessons/:lessonId')
  get(@Param('lessonId') lessonId: string, @Req() req: Request) {
    return this.lessons.get(requestContext(req), lessonId);
  }

  @Post('lessons/:lessonId/end')
  async end(@Param('lessonId') lessonId: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.lessons.end(requestContext(req), lessonId, idempotencyKeyOf(req));
    res.status(result.status);
    return result.body;
  }
}
