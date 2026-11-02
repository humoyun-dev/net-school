import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { createPowerScheduleRequestSchema, updatePowerScheduleRequestSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { idempotencyKeyOf } from '../../common/idempotency.ts';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { PowerSchedulesService } from './power-schedules.service.ts';

@Controller('api/v1/power-schedules')
export class PowerSchedulesController {
  constructor(@Inject(PowerSchedulesService) private readonly schedules: PowerSchedulesService) {}

  @Post()
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const key = idempotencyKeyOf(req);
    const input = parseBody(createPowerScheduleRequestSchema, body);
    const result = await this.schedules.create(requestContext(req), input, key);
    res.status(result.status);
    return result.body;
  }

  @Get()
  async list(@Req() req: Request) {
    return { schedules: await this.schedules.list(requestContext(req)) };
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.schedules.update(requestContext(req), id, parseBody(updatePowerScheduleRequestSchema, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: Request) {
    await this.schedules.remove(requestContext(req), id);
  }
}
