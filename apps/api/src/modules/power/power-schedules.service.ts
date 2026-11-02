import { Inject, Injectable } from '@nestjs/common';
import type {
  CreatePowerScheduleRequest,
  PowerSchedule,
  PowerScope,
  UpdatePowerScheduleRequest,
} from '@netschool/contracts';
import { nextOccurrence, POWER_MISSED_GRACE_MS, type WeeklyRule } from '@netschool/domain';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { Idempotency } from '../../common/idempotency.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { powerActions, powerSchedules, sites } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { PowerService, requireConfirmation } from './power.service.ts';
import { authorizeScope, canManage, resolveScope, scopeSummary } from './power-scope.ts';

type ScheduleRow = typeof powerSchedules.$inferSelect;
const DUE_PER_TICK = 20;

const ruleOf = (row: ScheduleRow): WeeklyRule => ({
  daysOfWeek: row.daysOfWeek,
  timeOfDay: row.timeOfDay,
  timezone: row.timezone,
});

@Injectable()
export class PowerSchedulesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(Idempotency) private readonly idempotency: Idempotency,
    @Inject(PowerService) private readonly power: PowerService,
  ) {}

  async create(
    ctx: RequestContext,
    input: CreatePowerScheduleRequest,
    key: string,
  ): Promise<{ status: number; body: PowerSchedule }> {
    const actor = this.access.actor(ctx);
    const siteIds = await authorizeScope(this.db, this.access, ctx, input.scope, {
      targetType: 'power_scope',
      targetId: input.scope.kind,
    });
    const scope = 'POST /power-schedules';
    const stored = await this.idempotency.replay<PowerSchedule>(ctx, scope, key, input);
    if (stored) return stored;
    // Bo'sh ko'lam ruxsat (yangi bino keyin to'ladi); ko'p qurilmada tasdiq.
    const found = await resolveScope(this.db, actor.organizationId, input.scope);
    requireConfirmation(found.length, input.confirmDeviceCount);
    const now = this.now();
    return this.idempotency.run(ctx, scope, key, input, 201, async (tx) => {
      const [row] = await tx
        .insert(powerSchedules)
        .values({
          organizationId: actor.organizationId,
          type: input.type,
          scope: input.scope,
          siteIds,
          daysOfWeek: input.rule.daysOfWeek,
          timeOfDay: input.rule.timeOfDay,
          timezone: input.rule.timezone,
          enabled: true,
          nextRunAt: new Date(nextOccurrence(input.rule, now)),
          createdBy: actor.userId,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        })
        .returning();
      if (!row) throw new Error('power schedule insert failed');
      await this.#audit(tx, ctx, row, 'power.schedule_create', {
        type: row.type,
        scope: scopeSummary(input.scope),
        rule: input.rule,
        deviceCount: found.length,
      });
      return this.view(row);
    });
  }

  async list(ctx: RequestContext): Promise<PowerSchedule[]> {
    const actor = this.access.actor(ctx);
    const rows = await this.db
      .select()
      .from(powerSchedules)
      .where(eq(powerSchedules.organizationId, actor.organizationId))
      .orderBy(desc(powerSchedules.createdAt), desc(powerSchedules.id));
    return rows
      .filter((r) => canManage(actor, r.organizationId, r.scope as PowerScope, r.siteIds))
      .map((r) => this.view(r));
  }

  async update(ctx: RequestContext, id: string, input: UpdatePowerScheduleRequest): Promise<PowerSchedule> {
    const found = await this.#manageable(ctx, id);
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(powerSchedules).where(eq(powerSchedules.id, found.id)).for('update');
      if (!current) throw new Error('power schedule missing');
      const rule = input.rule ?? ruleOf(current);
      const enabled = input.enabled ?? current.enabled;
      const recompute = input.rule !== undefined || (enabled && !current.enabled);
      const nextRunAt = !enabled ? null : recompute ? new Date(nextOccurrence(rule, now)) : current.nextRunAt;
      const [row] = await tx
        .update(powerSchedules)
        .set({
          daysOfWeek: rule.daysOfWeek,
          timeOfDay: rule.timeOfDay,
          timezone: rule.timezone,
          enabled,
          nextRunAt,
          updatedAt: new Date(now),
        })
        .where(eq(powerSchedules.id, current.id))
        .returning();
      if (!row) throw new Error('power schedule update failed');
      await this.#audit(tx, ctx, row, 'power.schedule_update', { ...input });
      return this.view(row);
    });
  }

  // Yaratilgan amallar qoladi (schedule_id → null).
  async remove(ctx: RequestContext, id: string): Promise<void> {
    const found = await this.#manageable(ctx, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(powerSchedules).where(eq(powerSchedules.id, found.id));
      await this.#audit(tx, ctx, found, 'power.schedule_delete', { type: found.type });
    });
  }

  // Vaqti kelgan jadvallar: bitta vaqtga bitta amal (unique (schedule_id, run_at)). Kechikkan → missed, ertalab
  // kechagi o'chirish bajarilmaydi. Ko'lam ishga tushish paytidagi holatda olinadi.
  async runDue(now: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(powerSchedules)
        .where(and(eq(powerSchedules.enabled, true), lte(powerSchedules.nextRunAt, new Date(now))))
        .orderBy(asc(powerSchedules.nextRunAt))
        .limit(DUE_PER_TICK)
        .for('update', { skipLocked: true });
      for (const schedule of due) {
        const runAt = schedule.nextRunAt;
        if (!runAt) continue;
        const scope = schedule.scope as PowerScope;
        const siteIds =
          scope.kind === 'organization'
            ? (
                await tx.select({ id: sites.id }).from(sites).where(eq(sites.organizationId, schedule.organizationId))
              ).map((s) => s.id)
            : schedule.siteIds;
        const missed = now - runAt.getTime() > POWER_MISSED_GRACE_MS;
        const [action] = await tx
          .insert(powerActions)
          .values({
            organizationId: schedule.organizationId,
            type: schedule.type,
            scope,
            siteIds,
            status: missed ? 'missed' : 'scheduled',
            runAt,
            scheduleId: schedule.id,
            requestedBy: null,
            createdAt: new Date(now),
            completedAt: missed ? new Date(now) : null,
          })
          .onConflictDoNothing({ target: [powerActions.scheduleId, powerActions.runAt] })
          .returning();
        if (action && missed) {
          await this.audit.write(
            tx,
            {
              organizationId: schedule.organizationId,
              siteId: siteIds.length === 1 ? (siteIds[0] ?? null) : null,
              actorUserId: null,
              action: 'power.missed',
              targetType: 'power_action',
              targetId: action.id,
              result: 'succeeded',
              details: { type: schedule.type, scheduleId: schedule.id, runAt: runAt.toISOString() },
            },
            `power-${action.id}`,
          );
        } else if (action) {
          await this.power.materialize(tx, action.id, now);
        }
        await tx
          .update(powerSchedules)
          .set({ nextRunAt: new Date(nextOccurrence(ruleOf(schedule), now)), updatedAt: new Date(now) })
          .where(eq(powerSchedules.id, schedule.id));
      }
    });
  }

  async #manageable(ctx: RequestContext, id: string): Promise<ScheduleRow> {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(powerSchedules)
          .where(and(eq(powerSchedules.id, id), eq(powerSchedules.organizationId, actor.organizationId)))
      : [];
    if (!row || !canManage(actor, row.organizationId, row.scope as PowerScope, row.siteIds)) {
      return this.access.deny(ctx, 'power.manage', { targetType: 'power_schedule', targetId: id });
    }
    return row;
  }

  #audit(tx: Db, ctx: RequestContext, row: ScheduleRow, action: string, details: Record<string, unknown>) {
    const actor = this.access.actor(ctx);
    return this.audit.write(
      tx,
      {
        organizationId: row.organizationId,
        siteId: row.siteIds.length === 1 ? (row.siteIds[0] ?? null) : null,
        actorUserId: actor.userId,
        action,
        targetType: 'power_schedule',
        targetId: row.id,
        result: 'succeeded',
        details,
      },
      ctx.correlationId,
    );
  }

  view(row: ScheduleRow): PowerSchedule {
    return {
      id: row.id,
      type: row.type as PowerSchedule['type'],
      scope: row.scope as PowerScope,
      rule: ruleOf(row),
      enabled: row.enabled,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
