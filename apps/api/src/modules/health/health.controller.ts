import { Controller, Get, Inject, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DB, type Db } from '../../db/client.ts';

@Controller('api/v1/healthz')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ok', db: 'ok' };
    } catch {
      res.status(503);
      return { status: 'degraded', db: 'down' };
    }
  }
}
