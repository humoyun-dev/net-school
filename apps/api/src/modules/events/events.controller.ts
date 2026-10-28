import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { EventsService } from './events.service.ts';

const querySchema = z.object({
  roomId: z.string(),
  after: z
    .string()
    .regex(/^\d{1,18}$/)
    .transform(Number)
    .optional(),
  wait: z.coerce.number().int().min(0).max(25).default(0),
});

@Controller('api/v1/events')
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}

  @Get()
  read(@Query() query: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { roomId, after, wait } = parseBody(querySchema, query);
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    return this.events.read(requestContext(req), roomId, after, wait, abort.signal);
  }
}
