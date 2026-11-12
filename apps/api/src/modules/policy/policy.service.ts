import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PolicyVersion } from '@netschool/contracts';
import { type BaselineDocument, type EffectiveBaseline, type LessonDocument, mergeBaseline } from '@netschool/domain';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { canonical } from '../../common/canonical-json.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUniqueViolation, isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { lessons, policyAssignments, policyVersions, sites } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';

type VersionRow = typeof policyVersions.$inferSelect;
export type Layer = 'baseline' | 'lesson';

export interface PolicyScope {
  organizationId: string;
  siteId: string | null;
  layer: Layer;
  lessonId: string | null;
}

export const hashOf = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export function toPolicyVersion(row: VersionRow): PolicyVersion {
  return {
    id: row.id,
    layer: row.layer as Layer,
    siteId: row.siteId,
    lessonId: row.lessonId,
    version: row.version,
    document: row.document,
    contentHash: row.contentHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    restoredFrom: row.restoredFrom,
  };
}

// `If-Match: <joriy versiya | 0>` — yo'qolgan yangilanishdan himoya; boshqa ko'rinish validatsiya xatosi.
export function parseIfMatch(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value.trim())) throw new ApiError('validation_failed');
  return Number(value.trim());
}

export function parseSiteId(value: unknown): string | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isUuid(value)) throw new ApiError('validation_failed');
  return value;
}

const scopeWhere = (table: typeof policyVersions | typeof policyAssignments, s: PolicyScope): SQL | undefined =>
  and(
    eq(table.organizationId, s.organizationId),
    s.siteId === null ? isNull(table.siteId) : eq(table.siteId, s.siteId),
    eq(table.layer, s.layer),
    s.lessonId === null ? isNull(table.lessonId) : eq(table.lessonId, s.lessonId),
  );

const MAX_LISTED_VERSIONS = 100;

@Injectable()
export class PolicyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  // Ko'lamning joriy versiyasi (assignment orqali).
  async current(db: Db, scope: PolicyScope): Promise<VersionRow | null> {
    const [row] = await db
      .select({ v: policyVersions })
      .from(policyAssignments)
      .innerJoin(policyVersions, eq(policyVersions.id, policyAssignments.versionId))
      .where(scopeWhere(policyAssignments, scope))
      .limit(1);
    return row?.v ?? null;
  }

  // Tashkilot ⊕ site bazaviy qatlami: revision har ko'lamning versiya raqami (0 — yo'q).
  async effectiveBaseline(
    organizationId: string,
    siteId: string,
  ): Promise<{ revision: { org: number; site: number }; document: EffectiveBaseline; hash: string }> {
    const base = { organizationId, layer: 'baseline' as const, lessonId: null };
    const [org, site] = await Promise.all([
      this.current(this.db, { ...base, siteId: null }),
      this.current(this.db, { ...base, siteId }),
    ]);
    const document = mergeBaseline(
      (org?.document as BaselineDocument | undefined) ?? null,
      (site?.document as BaselineDocument | undefined) ?? null,
    );
    return { revision: { org: org?.version ?? 0, site: site?.version ?? 0 }, document, hash: hashOf(document) };
  }

  async getBaseline(ctx: RequestContext, siteId: string | null) {
    const scope = await this.#baselineScope(ctx, siteId, 'policy.read');
    const current = await this.current(this.db, scope);
    const effective =
      siteId === null
        ? mergeBaseline((current?.document as BaselineDocument | undefined) ?? null, null)
        : (await this.effectiveBaseline(scope.organizationId, siteId)).document;
    return { current: current ? toPolicyVersion(current) : null, effective };
  }

  async listBaseline(ctx: RequestContext, siteId: string | null) {
    const scope = await this.#baselineScope(ctx, siteId, 'policy.read');
    const rows = await this.db
      .select()
      .from(policyVersions)
      .where(scopeWhere(policyVersions, scope))
      .orderBy(desc(policyVersions.version))
      .limit(MAX_LISTED_VERSIONS);
    return { versions: rows.map(toPolicyVersion) };
  }

  async putBaseline(ctx: RequestContext, siteId: string | null, ifMatch: number, document: BaselineDocument) {
    const scope = await this.#baselineScope(ctx, siteId, 'policy.manage');
    return this.createVersion(ctx, scope, ifMatch, document, null);
  }

  async restoreBaseline(ctx: RequestContext, versionId: string, ifMatch: number) {
    const actor = this.access.actor(ctx);
    const on = { targetType: 'policy_version', targetId: versionId };
    const [old] = isUuid(versionId)
      ? await this.db
          .select()
          .from(policyVersions)
          .where(and(eq(policyVersions.id, versionId), eq(policyVersions.organizationId, actor.organizationId)))
      : [];
    if (old?.layer !== 'baseline') return this.access.deny(ctx, 'policy.manage', on);
    const scope = await this.#baselineScope(ctx, old.siteId, 'policy.manage');
    return this.createVersion(ctx, scope, ifMatch, old.document, old.id);
  }

  async getLesson(ctx: RequestContext, lessonId: string) {
    const { scope } = await this.#lessonScope(ctx, lessonId, 'lesson.read');
    const current = await this.current(this.db, scope);
    return { current: current ? toPolicyVersion(current) : null };
  }

  async putLesson(ctx: RequestContext, lessonId: string, ifMatch: number, document: LessonDocument) {
    const { scope, active } = await this.#lessonScope(ctx, lessonId, 'lesson.policy');
    // Tugagan darsning qatlami qurilmaga berilmaydi; o'zgartirish ma'nosiz va chalg'ituvchi.
    if (!active) throw new ApiError('conflict');
    return this.createVersion(ctx, scope, ifMatch, document, null);
  }

  // Qurilmaga beriladigan dars qatlami (faqat joriy versiya; dars faolligini chaqiruvchi tekshiradi).
  async lessonLayerOf(
    organizationId: string,
    siteId: string,
    lessonId: string,
  ): Promise<{ versionId: string; version: number; contentHash: string; document: LessonDocument } | null> {
    const row = await this.current(this.db, { organizationId, siteId, layer: 'lesson', lessonId });
    if (!row) return null;
    return {
      versionId: row.id,
      version: row.version,
      contentHash: row.contentHash,
      document: row.document as LessonDocument,
    };
  }

  // Yangi immutable versiya + assignment + audit bitta tranzaksiyada. Mazmun joriy bilan bir xil bo'lsa — 200 joriy.
  async createVersion(
    ctx: RequestContext,
    scope: PolicyScope,
    ifMatch: number,
    document: unknown,
    restoredFrom: string | null,
  ): Promise<{ status: number; body: PolicyVersion }> {
    const actor = this.access.actor(ctx);
    const contentHash = hashOf(document);
    try {
      return await this.db.transaction(async (tx) => {
        const [assignment] = await tx
          .select()
          .from(policyAssignments)
          .where(scopeWhere(policyAssignments, scope))
          .for('update');
        const currentVersion = assignment?.version ?? 0;
        if (ifMatch !== currentVersion) throw new ApiError('conflict');
        if (assignment) {
          const [cur] = await tx.select().from(policyVersions).where(eq(policyVersions.id, assignment.versionId));
          if (cur && cur.contentHash === contentHash && restoredFrom === null) {
            return { status: 200, body: toPolicyVersion(cur) };
          }
        }
        const now = new Date(this.now());
        const [row] = await tx
          .insert(policyVersions)
          .values({
            ...scope,
            version: currentVersion + 1,
            document,
            contentHash,
            createdBy: actor.userId,
            createdAt: now,
            restoredFrom,
          })
          .returning();
        if (!row) throw new Error('policy version insert failed');
        if (assignment) {
          await tx
            .update(policyAssignments)
            .set({ versionId: row.id, version: row.version, updatedAt: now })
            .where(eq(policyAssignments.id, assignment.id));
        } else {
          await tx
            .insert(policyAssignments)
            .values({ ...scope, versionId: row.id, version: row.version, updatedAt: now });
        }
        await this.audit.write(
          tx,
          {
            organizationId: scope.organizationId,
            siteId: scope.siteId,
            actorUserId: actor.userId,
            action: scope.layer === 'baseline' ? 'policy.baseline_changed' : 'policy.lesson_changed',
            targetType: 'policy_version',
            targetId: row.id,
            result: 'succeeded',
            details: { version: row.version, lessonId: scope.lessonId, restoredFrom },
          },
          ctx.correlationId,
        );
        return { status: 201, body: toPolicyVersion(row) };
      });
    } catch (err) {
      // Parallel birinchi versiya yoki bir xil raqam: kimdir oldin yozdi.
      if (isUniqueViolation(err)) throw new ApiError('conflict');
      throw err;
    }
  }

  async #lessonScope(
    ctx: RequestContext,
    lessonId: string,
    action: 'lesson.read' | 'lesson.policy',
  ): Promise<{ scope: PolicyScope; active: boolean }> {
    const actor = this.access.actor(ctx);
    const on = { targetType: 'lesson', targetId: lessonId };
    const [lesson] = isUuid(lessonId)
      ? await this.db
          .select()
          .from(lessons)
          .where(and(eq(lessons.id, lessonId), eq(lessons.organizationId, actor.organizationId)))
      : [];
    if (!lesson) return this.access.deny(ctx, action, on);
    await this.access.require(
      ctx,
      action,
      {
        organizationId: lesson.organizationId,
        siteId: lesson.siteId,
        roomId: lesson.roomId,
        ownerUserId: lesson.teacherUserId,
      },
      on,
    );
    return {
      scope: { organizationId: lesson.organizationId, siteId: lesson.siteId, layer: 'lesson', lessonId: lesson.id },
      active: lesson.status === 'active',
    };
  }

  async #baselineScope(
    ctx: RequestContext,
    siteId: string | null,
    action: 'policy.read' | 'policy.manage',
  ): Promise<PolicyScope> {
    const actor = this.access.actor(ctx);
    const on = { targetType: 'policy_scope', targetId: siteId ?? 'organization' };
    if (siteId !== null) {
      const [site] = await this.db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, siteId), eq(sites.organizationId, actor.organizationId)));
      if (!site) return this.access.deny(ctx, action, on, null);
    }
    await this.access.require(ctx, action, { organizationId: actor.organizationId, siteId }, on);
    return { organizationId: actor.organizationId, siteId, layer: 'baseline', lessonId: null };
  }
}
