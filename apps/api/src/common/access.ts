import { Inject, Injectable } from '@nestjs/common';
import { type Action, type Actor, authorize, type Target } from '@netschool/domain';
import { DB, type Db } from '../db/client.ts';
import { AuditWriter } from '../modules/audit/audit.writer.ts';
import { ApiError } from './errors.ts';
import type { RequestContext } from './request-context.ts';

export interface AuditTarget {
  targetType: string;
  targetId: string;
}

// Ruxsat tekshiruvi + rad etishni audit qilish. Rad etish yozuvi o'z tranzaksiyasida commit bo'ladi.
@Injectable()
export class Access {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  actor(ctx: RequestContext): Actor {
    if (!ctx.actor) throw new ApiError('unauthenticated');
    return ctx.actor;
  }

  async require(ctx: RequestContext, action: Action, target: Target, on: AuditTarget): Promise<Actor> {
    const actor = this.actor(ctx);
    if (authorize(actor, action, target).allowed) return actor;
    return this.deny(ctx, action, on, target.siteId ?? null);
  }

  // Topilmagan yoki begona obyekt — mavjudlik oshkor bo'lmasligi uchun xuddi ruxsatsizlik kabi.
  async deny(ctx: RequestContext, action: Action, on: AuditTarget, siteId: string | null = null): Promise<never> {
    const actor = this.actor(ctx);
    await this.audit.write(
      this.db,
      { organizationId: actor.organizationId, siteId, actorUserId: actor.userId, action, ...on, result: 'denied' },
      ctx.correlationId,
    );
    throw new ApiError('scope_denied');
  }
}
