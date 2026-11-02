import { Inject, Injectable } from '@nestjs/common';
import type {
  CreatePowerActionRequest,
  PowerAction,
  PowerPreview,
  PowerScope,
  PowerTarget,
  PreviewPowerRequest,
} from '@netschool/contracts';
import {
  type Actor,
  POWER_MAX_LEAD_MS,
  POWER_MISSED_GRACE_MS,
  POWER_TARGET_STATUSES,
  type PowerTargetStatus,
} from '@netschool/domain';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import { Idempotency } from '../../common/idempotency.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { API_CONFIG, type ApiConfig } from '../../config/config.ts';
import { DB, type Db } from '../../db/client.ts';
import { devices, meshBindings, powerActions, powerActionTargets, sites } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { DEVICE_MANAGEMENT, type DeviceManagementFactory, requirePort } from '../devices/mesh.ts';
import { authorizeScope, canManage, resolveScope, type ScopeDevice, scopeSummary } from './power-scope.ts';

type ActionRow = typeof powerActions.$inferSelect;
const TARGET_INSERT_CHUNK = 1_000;

// Ro'yxat SQL'da filtrlanadi: org admin — hammasi; site admin/IT — faqat ko'lami o'z site'larida bo'lganlar.
export function visibleSitesFilter(actor: Actor): string[] | null {
  const own = actor.assignments.filter((a) => a.organizationId === actor.organizationId);
  if (own.some((a) => a.role === 'school_admin' && a.siteId === null)) return null;
  return [
    ...new Set(
      own
        .filter((a) => (a.role === 'school_admin' || a.role === 'it_support') && a.siteId !== null)
        .map((a) => a.siteId as string),
    ),
  ];
}

// Ko'p qurilmali amal: admin ko'rgan son joriy songa aynan teng bo'lishi shart (spec §7.1).
export function requireConfirmation(count: number, confirmed: number | undefined): void {
  if (count > 1 && confirmed !== count) throw new ApiError('confirmation_required');
}

@Injectable()
export class PowerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(Idempotency) private readonly idempotency: Idempotency,
    @Inject(DEVICE_MANAGEMENT) private readonly factory: DeviceManagementFactory | null,
  ) {}

  async preview(ctx: RequestContext, input: PreviewPowerRequest): Promise<PowerPreview> {
    const actor = this.access.actor(ctx);
    await authorizeScope(this.db, this.access, ctx, input.scope, {
      targetType: 'power_scope',
      targetId: input.scope.kind,
    });
    const found = await resolveScope(this.db, actor.organizationId, input.scope);
    const unbound = found.filter((d) => !d.bound).length;
    const online = await this.#onlineCount(found.filter((d) => d.bound));
    return {
      deviceCount: found.length,
      unbound,
      agentOnline: online,
      agentOffline: online === null ? null : found.length - unbound - online,
    };
  }

  // Bog'langan qurilmalardan nechtasining agenti online; MeshCentral javob bermasa null.
  async #onlineCount(bound: ScopeDevice[]): Promise<number | null> {
    if (bound.length === 0) return 0;
    try {
      const ids = new Set(bound.map((d) => d.id));
      const bySite = [...new Set(bound.map((d) => d.siteId))];
      const siteRows = await this.db.select().from(sites).where(inArray(sites.id, bySite));
      const bindings = await this.db
        .select({ deviceId: meshBindings.deviceId, nodeId: meshBindings.meshNodeId })
        .from(meshBindings)
        .where(inArray(meshBindings.deviceId, [...ids]));
      let online = 0;
      for (const site of siteRows) {
        const { port } = requirePort(this.factory, this.config.meshInstanceId, site);
        const snapshots = await port.listDevices(site.id);
        const up = new Set(snapshots.filter((s) => s.agentOnline).map((s) => s.upstream.meshNodeId));
        const here = new Set(bound.filter((d) => d.siteId === site.id).map((d) => d.id));
        online += bindings.filter((b) => here.has(b.deviceId) && up.has(b.nodeId)).length;
      }
      return online;
    } catch {
      return null;
    }
  }

  async create(
    ctx: RequestContext,
    input: CreatePowerActionRequest,
    key: string,
  ): Promise<{ status: number; body: PowerAction }> {
    const actor = this.access.actor(ctx);
    const now = this.now();
    const runAtMs = input.runAt === undefined ? now : Date.parse(input.runAt);
    if (runAtMs > now + POWER_MAX_LEAD_MS) throw new ApiError('validation_failed', 'runAt is too far ahead');
    // Eskirgan vaqt (masalan kechagi so'rovning qayta urinishi) hozir bajarilmaydi.
    if (runAtMs < now - POWER_MISSED_GRACE_MS) throw new ApiError('validation_failed', 'runAt is in the past');
    const siteIds = await authorizeScope(this.db, this.access, ctx, input.scope, {
      targetType: 'power_scope',
      targetId: input.scope.kind,
    });
    const scope = 'POST /power-actions';
    const stored = await this.idempotency.replay<PowerAction>(ctx, scope, key, input);
    if (stored) return stored;
    const found = await resolveScope(this.db, actor.organizationId, input.scope);
    if (found.length === 0) throw new ApiError('conflict', 'No devices in scope');
    requireConfirmation(found.length, input.confirmDeviceCount);

    return this.idempotency.run(ctx, scope, key, input, 202, async (tx) => {
      const scheduled = runAtMs > now;
      const [action] = await tx
        .insert(powerActions)
        .values({
          organizationId: actor.organizationId,
          type: input.type,
          scope: input.scope,
          siteIds,
          status: scheduled ? 'scheduled' : 'running',
          runAt: new Date(scheduled ? runAtMs : now),
          requestedBy: actor.userId,
          createdAt: new Date(now),
        })
        .returning();
      if (!action) throw new Error('power action insert failed');
      if (!scheduled) await this.materialize(tx, action.id, now);
      await this.audit.write(
        tx,
        {
          organizationId: actor.organizationId,
          siteId: siteIds.length === 1 ? (siteIds[0] ?? null) : null,
          actorUserId: actor.userId,
          action: 'power.request',
          targetType: 'power_action',
          targetId: action.id,
          result: 'succeeded',
          details: {
            type: input.type,
            scope: scopeSummary(input.scope),
            deviceCount: found.length,
            runAt: action.runAt.toISOString(),
          },
        },
        ctx.correlationId,
      );
      return this.view(tx, action.id, false);
    });
  }

  // Amal boshlanadi: joriy ko'lam bo'yicha targetlar (unbound → failed), status running, birinchi to'lqin darhol.
  async materialize(tx: Db, actionId: string, now: number): Promise<void> {
    const [action] = await tx.select().from(powerActions).where(eq(powerActions.id, actionId));
    if (!action) throw new Error('power action missing');
    const found = await resolveScope(tx, action.organizationId, action.scope as PowerScope);
    const at = new Date(now);
    // Bo'laklab: PostgreSQL bitta so'rovda ≤ 65 535 parametr (butun universitet — minglab qurilma).
    for (let i = 0; i < found.length; i += TARGET_INSERT_CHUNK) {
      await tx.insert(powerActionTargets).values(
        found.slice(i, i + TARGET_INSERT_CHUNK).map((d) => ({
          actionId,
          deviceId: d.id,
          organizationId: action.organizationId,
          siteId: d.siteId,
          status: d.bound ? 'pending' : 'failed',
          reason: d.bound ? null : 'unbound',
          finishedAt: d.bound ? null : at,
          updatedAt: at,
        })),
      );
    }
    await tx.update(powerActions).set({ status: 'running', nextWaveAt: at }).where(eq(powerActions.id, actionId));
  }

  async list(ctx: RequestContext, limit: number): Promise<PowerAction[]> {
    const actor = this.access.actor(ctx);
    const allowed = visibleSitesFilter(actor);
    if (allowed !== null && allowed.length === 0) return [];
    const rows = await this.db
      .select()
      .from(powerActions)
      .where(
        and(
          eq(powerActions.organizationId, actor.organizationId),
          allowed === null
            ? undefined
            : sql`${powerActions.scope} ->> 'kind' <> 'organization' and ${powerActions.siteIds} <@ array[${sql.join(
                allowed.map((id) => sql`${id}`),
                sql`, `,
              )}]::uuid[]`,
        ),
      )
      .orderBy(desc(powerActions.createdAt), desc(powerActions.id))
      .limit(limit);
    // SQL filtri bilan bir xil qoida (authorize) — ikkinchi himoya.
    const visible = rows.filter((r) => canManage(actor, r.organizationId, r.scope as PowerScope, r.siteIds));
    return Promise.all(visible.map((r) => this.view(this.db, r.id, false)));
  }

  async get(ctx: RequestContext, id: string): Promise<PowerAction> {
    const action = await this.#manageable(ctx, id);
    return this.view(this.db, action.id, true);
  }

  async cancel(ctx: RequestContext, id: string): Promise<PowerAction> {
    const actor = this.access.actor(ctx);
    const found = await this.#manageable(ctx, id);
    const now = new Date(this.now());
    return this.db.transaction(async (tx) => {
      const [action] = await tx.select().from(powerActions).where(eq(powerActions.id, found.id)).for('update');
      if (!action) throw new Error('power action missing');
      let cancelledTargets = 0;
      if (action.status === 'scheduled') {
        await tx
          .update(powerActions)
          .set({ status: 'cancelled', completedAt: now })
          .where(eq(powerActions.id, action.id));
      } else if (action.status === 'running') {
        // Yuborilgan targetlar kuzatuvda qoladi; faqat navbatdagilar bekor.
        const rows = await tx
          .update(powerActionTargets)
          .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
          .where(and(eq(powerActionTargets.actionId, action.id), eq(powerActionTargets.status, 'pending')))
          .returning({ deviceId: powerActionTargets.deviceId });
        cancelledTargets = rows.length;
      }
      await this.audit.write(
        tx,
        {
          organizationId: action.organizationId,
          siteId: action.siteIds.length === 1 ? (action.siteIds[0] ?? null) : null,
          actorUserId: actor.userId,
          action: 'power.cancel',
          targetType: 'power_action',
          targetId: action.id,
          result: 'succeeded',
          details: { previousStatus: action.status, cancelledTargets },
        },
        ctx.correlationId,
      );
      return this.view(tx, action.id, false);
    });
  }

  async #manageable(ctx: RequestContext, id: string): Promise<ActionRow> {
    const actor = this.access.actor(ctx);
    const [action] = isUuid(id)
      ? await this.db
          .select()
          .from(powerActions)
          .where(and(eq(powerActions.id, id), eq(powerActions.organizationId, actor.organizationId)))
      : [];
    if (!action || !canManage(actor, action.organizationId, action.scope as PowerScope, action.siteIds)) {
      return this.access.deny(ctx, 'power.manage', { targetType: 'power_action', targetId: id });
    }
    return action;
  }

  // Har target alohida; summary har holat soni (umumiy "success" yo'q).
  async view(db: Db, id: string, withTargets: boolean): Promise<PowerAction> {
    const [action] = await db.select().from(powerActions).where(eq(powerActions.id, id));
    if (!action) throw new Error('power action missing');
    const rows = await db
      .select({ target: powerActionTargets, hostname: devices.hostname, roomId: devices.roomId })
      .from(powerActionTargets)
      .innerJoin(devices, eq(devices.id, powerActionTargets.deviceId))
      .where(eq(powerActionTargets.actionId, id))
      .orderBy(asc(devices.hostname), asc(powerActionTargets.deviceId));
    const summary = Object.fromEntries(POWER_TARGET_STATUSES.map((s) => [s, 0])) as Record<PowerTargetStatus, number>;
    for (const { target } of rows) summary[target.status as PowerTargetStatus] += 1;
    const view: PowerAction = {
      id: action.id,
      type: action.type as PowerAction['type'],
      scope: action.scope as PowerScope,
      status: action.status as PowerAction['status'],
      runAt: action.runAt.toISOString(),
      scheduleId: action.scheduleId,
      requestedBy: action.requestedBy,
      createdAt: action.createdAt.toISOString(),
      completedAt: action.completedAt?.toISOString() ?? null,
      summary,
    };
    if (withTargets) {
      view.targets = rows.map(
        ({ target, hostname, roomId }): PowerTarget => ({
          deviceId: target.deviceId,
          hostname,
          siteId: target.siteId,
          roomId,
          status: target.status as PowerTarget['status'],
          reason: target.reason as PowerTarget['reason'],
          sentAt: target.sentAt?.toISOString() ?? null,
          finishedAt: target.finishedAt?.toISOString() ?? null,
        }),
      );
    }
    return view;
  }
}
