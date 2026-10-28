import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { auditQuerySchema } from '@netschool/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { Access } from '../../common/access.ts';
import { ApiError } from '../../common/errors.ts';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { DB, type Db } from '../../db/client.ts';
import { auditEvents } from '../../db/schema.ts';

// Cursor: oxirgi yozuvning (at, id) juftligi, base64url JSON. `at` PostgreSQL matn ko'rinishida —
// mikrosekund aniqligi saqlanadi (JS Date millisekundgacha qisqartirib, qatorlarni tashlab yuborardi).
const AT_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}

function decodeCursor(value: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof at !== 'string' || !AT_TEXT.test(at) || typeof id !== 'string' || !UUID.test(id)) throw new Error();
    return { at, id };
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
      .select({ event: auditEvents, atText: sql<string>`${auditEvents.at}::text` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, actor.organizationId),
          siteId ? eq(auditEvents.siteId, siteId) : undefined,
          cursor
            ? sql`(${auditEvents.at}, ${auditEvents.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      events: page.map(({ event: e }) => ({
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
      nextCursor: rows.length > limit && last ? encodeCursor(last.atText, last.event.id) : null,
    };
  }
}
