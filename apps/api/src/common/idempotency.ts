import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { idempotencyKeySchema } from '@netschool/contracts';
import { and, eq, lte } from 'drizzle-orm';
import type { Request } from 'express';
import { DB, type Db } from '../db/client.ts';
import { idempotencyKeys } from '../db/schema.ts';
import { canonical } from './canonical-json.ts';
import { CLOCK, type Clock } from './clock.ts';
import { isUniqueViolation, violatedConstraint } from './db-errors.ts';
import { ApiError } from './errors.ts';
import type { RequestContext } from './request-context.ts';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const hashRequest = (request: unknown) => createHash('sha256').update(canonical(request)).digest('hex');

export function idempotencyKeyOf(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.headers['idempotency-key']);
  if (!parsed.success) throw new ApiError('validation_failed', 'Idempotency-Key header is required');
  return parsed.data;
}

// Spec §9: takroriy so'rov yangi mutatsiya yaratmaydi. Kalit qatori ish bilan bitta tranzaksiyada:
// commit bo'lmasa kalit saqlanmaydi (xato javoblar keshlanmaydi).
@Injectable()
export class Idempotency {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  // Ish boshlanishidan oldingi tekshiruvlar (masalan a'zolik) takroriy so'rovni rad etmasligi uchun.
  async replay<T>(
    ctx: RequestContext,
    scope: string,
    key: string,
    request: unknown,
  ): Promise<{ status: number; body: T } | null> {
    if (!ctx.actor) throw new ApiError('unauthenticated');
    const [stored] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.actorUserId, ctx.actor.userId),
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
        ),
      );
    if (!stored || stored.createdAt.getTime() <= this.now() - IDEMPOTENCY_TTL_MS || stored.responseStatus === null) {
      return null;
    }
    if (stored.requestHash !== hashRequest(request)) {
      throw new ApiError('conflict', 'Idempotency-Key was used with a different request');
    }
    return { status: stored.responseStatus, body: stored.responseBody as T };
  }

  async run<T>(
    ctx: RequestContext,
    scope: string,
    key: string,
    request: unknown,
    status: number,
    work: (tx: Db) => Promise<T>,
  ): Promise<{ status: number; body: T }> {
    if (!ctx.actor) throw new ApiError('unauthenticated');
    const actorUserId = ctx.actor.userId;
    const requestHash = hashRequest(request);
    const now = this.now();
    const pk = and(
      eq(idempotencyKeys.actorUserId, actorUserId),
      eq(idempotencyKeys.scope, scope),
      eq(idempotencyKeys.key, key),
    );
    try {
      return await this.db.transaction(async (tx) => {
        await tx
          .delete(idempotencyKeys)
          .where(and(pk, lte(idempotencyKeys.createdAt, new Date(now - IDEMPOTENCY_TTL_MS))));
        // Birinchi yozuv: parallel so'rov shu qatorda kutadi, commit'dan keyin unique xatosini oladi.
        await tx.insert(idempotencyKeys).values({ actorUserId, scope, key, requestHash, createdAt: new Date(now) });
        const body = await work(tx);
        await tx
          .update(idempotencyKeys)
          .set({ responseStatus: status, responseBody: body as unknown })
          .where(pk);
        return { status, body };
      });
    } catch (err) {
      // Faqat kalitning o'z PK'si; ish ichidagi boshqa unique xatolari o'zicha qoladi.
      if (!isUniqueViolation(err) || violatedConstraint(err) !== 'idempotency_keys_pk') throw err;
      const [stored] = await this.db.select().from(idempotencyKeys).where(pk);
      if (!stored || stored.requestHash !== requestHash || stored.responseStatus === null) {
        throw new ApiError('conflict', 'Idempotency-Key was used with a different request');
      }
      return { status: stored.responseStatus, body: stored.responseBody as T };
    }
  }
}
