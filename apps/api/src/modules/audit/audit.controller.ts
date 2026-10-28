import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { auditQuerySchema } from '@netschool/contracts';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { Request } from 'express';
import { Access } from '../../common/access.ts';
import { ApiError } from '../../common/errors.ts';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { DB, type Db } from '../../db/client.ts';
import { auditEvents } from '../../db/schema.ts';

// Cursor: oxirgi yozuvning (at, id) juftligi, base64url JSON.
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

function decodeCursor(value: string): { at: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as [string, string];
    const date = new Date(at);
    if (Number.isNaN(date.getTime()) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error();
    return { at: date, id };
  } catch {
    throw new ApiError('validation_failed');
  }
}

@Controller('api/v1/audit-events')
export class AuditController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(Access) private readonly access: Access,
  ) {}

  @Get()
  async list(@Query() query: unknown, @Req() req: Request) {
    const ctx = requestContext(req);
    const { siteId, limit, before } = parseBody(auditQuerySchema, query);
    const actor = this.access.actor(ctx);
    await this.access.require(
      ctx,
      'audit.read',
      { organizationId: actor.organizationId, siteId: siteId ?? null },
      { targetType: 'site', targetId: siteId ?? '*' },
    );
    const cursor = before ? decodeCursor(before) : undefined;
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, actor.organizationId),
          siteId ? eq(auditEvents.siteId, siteId) : undefined,
          cursor
            ? or(lt(auditEvents.at, cursor.at), and(eq(auditEvents.at, cursor.at), lt(auditEvents.id, cursor.id)))
            : undefined,
        ),
      )
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      events: page.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        siteId: e.siteId,
        actorUserId: e.actorUserId,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        result: e.result,
        correlationId: e.correlationId,
        details: e.details,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.id) : null,
    };
  }
}
