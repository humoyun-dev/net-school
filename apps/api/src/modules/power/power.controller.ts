import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { createPowerActionRequestSchema, previewPowerRequestSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { idempotencyKeyOf } from '../../common/idempotency.ts';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { PowerService } from './power.service.ts';

const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

@Controller('api/v1/power-actions')
export class PowerController {
  constructor(@Inject(PowerService) private readonly power: PowerService) {}

  @Post('preview')
  @HttpCode(200)
  preview(@Body() body: unknown, @Req() req: Request) {
    return this.power.preview(requestContext(req), parseBody(previewPowerRequestSchema, body));
  }

  // 202: qabul qilindi, kompyuterlarda bajarildi degani emas (natija har target bo'yicha).
  @Post()
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const key = idempotencyKeyOf(req);
    const input = parseBody(createPowerActionRequestSchema, body);
    const result = await this.power.create(requestContext(req), input, key);
    res.status(result.status);
    return result.body;
  }

  @Get()
  async list(@Query() query: unknown, @Req() req: Request) {
    const { limit } = parseBody(listQuerySchema, query);
    return { actions: await this.power.list(requestContext(req), limit) };
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Request) {
    return this.power.get(requestContext(req), id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Req() req: Request) {
    return this.power.cancel(requestContext(req), id);
  }
}
