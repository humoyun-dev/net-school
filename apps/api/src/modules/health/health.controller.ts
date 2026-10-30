import { Controller, Get, Inject, Res } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import { Public } from '../../common/route-flags.ts';
import { DB, type Db } from '../../db/client.ts';

// MeshCentral control ulanishi (main.ts'da MeshControlClient); null — MeshCentral sozlanmagan.
export interface MeshLink {
  readonly connected: boolean;
}

export const MESH_LINK = Symbol('MESH_LINK');

@Public()
@Controller('api/v1/healthz')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MESH_LINK) private readonly mesh: MeshLink | null,
  ) {}

  // Status faqat DB'ga bog'liq: API MeshCentral'siz ham ishlaydi, shuning uchun mesh `down` bo'lsa ham 200.
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const mesh = this.mesh === null ? 'disabled' : this.mesh.connected ? 'ok' : 'down';
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ok', db: 'ok', mesh };
    } catch {
      res.status(503);
      return { status: 'degraded', db: 'down', mesh };
    }
  }
}
