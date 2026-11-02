import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  type DeviceSnapshot,
  judgePowerTarget,
  POWER_MISSED_GRACE_MS,
  POWER_SEND_GIVE_UP_MS,
  POWER_TARGET_STATUSES,
  POWER_WAVE_INTERVAL_MS,
  POWER_WAVE_SIZE,
  type PowerActionType,
  type PowerTargetStatus,
} from '@netschool/domain';
import { and, asc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { API_CONFIG, type ApiConfig } from '../../config/config.ts';
import { DB, type Db } from '../../db/client.ts';
import { meshBindings, powerActions, powerActionTargets, sites } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { DEVICE_MANAGEMENT, type DeviceManagementFactory, requirePort } from '../devices/mesh.ts';
import { MESH_LINK, type MeshLink } from '../health/health.controller.ts';
import { WORKERS_ENABLED } from '../workers/outbox.worker.ts';
import { PowerService } from './power.service.ts';

const INTERVAL_MS = 1_000;
const SEND_CONCURRENCY = 16;
// Bitta tick'da ko'pi bilan shuncha amal (har biri bitta to'lqin).
const ACTIONS_PER_TICK = 20;

interface WaveTarget {
  deviceId: string;
  siteId: string;
  nodeId: string;
  meshDomainId: string;
}

// Quvvat amallari: vaqti kelganini boshlash, to'lqinlar bilan yuborish, natijani kuzatish, yakunlash.
// Yuborish ko'pi bilan bir marta: target `sent` bo'lib commit qilinadi, keyin MeshCentral'ga ketadi — jarayon
// o'lsa yoki javob kelmasa qayta yuborilmaydi (reboot ikki marta bo'lmaydi), natijani kuzatuv hal qiladi.
@Injectable()
export class PowerWorker implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #log = new Logger('PowerWorker');
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(WORKERS_ENABLED) private readonly enabled: boolean,
    @Inject(MESH_LINK) private readonly link: MeshLink | null,
    @Inject(DEVICE_MANAGEMENT) private readonly factory: DeviceManagementFactory | null,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(PowerService) private readonly power: PowerService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.#timer = setInterval(() => void this.#safeTick(), INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.#timer);
  }

  async #safeTick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.tick(this.now());
    } catch (err) {
      this.#log.error(`power tick failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      this.#running = false;
    }
  }

  async tick(now: number): Promise<void> {
    await this.#startDue(now);
    await this.#dispatch(now);
    await this.#reconcile(now);
    await this.#finish(now);
  }

  async #startDue(now: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(powerActions)
        .where(and(eq(powerActions.status, 'scheduled'), lte(powerActions.runAt, new Date(now))))
        .orderBy(asc(powerActions.runAt))
        .limit(ACTIONS_PER_TICK)
        .for('update', { skipLocked: true });
      for (const action of due) {
        if (now - action.runAt.getTime() > POWER_MISSED_GRACE_MS) {
          await tx
            .update(powerActions)
            .set({ status: 'missed', completedAt: new Date(now) })
            .where(eq(powerActions.id, action.id));
          await this.#systemAudit(tx, action, 'power.missed', { runAt: action.runAt.toISOString() });
        } else {
          await this.power.materialize(tx, action.id, now);
        }
      }
    });
  }

  async #dispatch(now: number): Promise<void> {
    if (!this.link?.connected || !this.factory) {
      // MeshCentral'siz yuborilmaydi; uzoq kutgan targetlar yuborilmagani aniq — failed.
      await this.db
        .update(powerActionTargets)
        .set({ status: 'failed', reason: 'upstream_unavailable', finishedAt: new Date(now), updatedAt: new Date(now) })
        .where(
          and(
            eq(powerActionTargets.status, 'pending'),
            inArray(
              powerActionTargets.actionId,
              this.db
                .select({ id: powerActions.id })
                .from(powerActions)
                .where(
                  and(
                    eq(powerActions.status, 'running'),
                    lte(powerActions.runAt, new Date(now - POWER_SEND_GIVE_UP_MS)),
                  ),
                ),
            ),
          ),
        );
      return;
    }
    const skipped = new Set<string>();
    for (let i = 0; i < ACTIONS_PER_TICK; i++) {
      const wave = await this.#claimWave(now, skipped);
      if (!wave) return;
      await this.#send(wave.type, wave.targets, now);
    }
  }

  // Bitta amalning navbatdagi to'lqini: holat tekshiruvi, `sent` belgilanadi va commit. Keyin yuboriladi.
  async #claimWave(
    now: number,
    skipped: Set<string>,
  ): Promise<{ type: PowerActionType; targets: WaveTarget[] } | null> {
    return this.db.transaction(async (tx) => {
      const [action] = await tx
        .select()
        .from(powerActions)
        .where(
          and(
            eq(powerActions.status, 'running'),
            lte(powerActions.nextWaveAt, new Date(now)),
            skipped.size > 0 ? notInArray(powerActions.id, [...skipped]) : undefined,
          ),
        )
        .orderBy(asc(powerActions.nextWaveAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!action) return null;
      skipped.add(action.id);
      const type = action.type as PowerActionType;
      const rows = await tx
        .select({
          deviceId: powerActionTargets.deviceId,
          siteId: powerActionTargets.siteId,
          nodeId: meshBindings.meshNodeId,
          meshDomainId: meshBindings.meshDomainId,
        })
        .from(powerActionTargets)
        .leftJoin(meshBindings, eq(meshBindings.deviceId, powerActionTargets.deviceId))
        .where(and(eq(powerActionTargets.actionId, action.id), eq(powerActionTargets.status, 'pending')))
        .orderBy(asc(powerActionTargets.deviceId))
        .limit(POWER_WAVE_SIZE)
        .for('update', { of: powerActionTargets, skipLocked: true });
      const at = new Date(now);
      await tx
        .update(powerActions)
        .set({ nextWaveAt: new Date(now + POWER_WAVE_INTERVAL_MS) })
        .where(eq(powerActions.id, action.id));
      if (rows.length === 0) return { type, targets: [] };

      let snapshots: Map<string, DeviceSnapshot>;
      try {
        snapshots = await this.#snapshots(tx, [...new Set(rows.map((r) => r.siteId))]);
      } catch {
        // MeshCentral javob bermadi: to'lqin keyingi intervalda qayta olinadi (hech narsa yuborilmagan).
        return { type, targets: [] };
      }
      const toSend: WaveTarget[] = [];
      const set = async (deviceId: string, values: Partial<typeof powerActionTargets.$inferInsert>) =>
        tx
          .update(powerActionTargets)
          .set({ ...values, updatedAt: at })
          .where(and(eq(powerActionTargets.actionId, action.id), eq(powerActionTargets.deviceId, deviceId)));
      for (const r of rows) {
        if (r.nodeId === null || r.meshDomainId === null) {
          // Amal boshlangandan keyin bog'lanish olib tashlangan.
          await set(r.deviceId, { status: 'failed', reason: 'unbound', finishedAt: at });
          continue;
        }
        const snap = snapshots.get(`${r.siteId}\u0000${r.nodeId}`);
        const online = snap?.agentOnline === true;
        if (type === 'wake' && online) {
          await set(r.deviceId, { status: 'succeeded', finishedAt: at });
        } else if (type !== 'wake' && !online) {
          await set(r.deviceId, { status: 'failed', reason: 'device_offline', finishedAt: at });
        } else {
          await set(r.deviceId, { status: 'sent', sentAt: at });
          toSend.push({ deviceId: r.deviceId, siteId: r.siteId, nodeId: r.nodeId, meshDomainId: r.meshDomainId });
        }
      }
      return { type, targets: toSend };
    });
  }

  async #send(type: PowerActionType, targets: WaveTarget[], now: number): Promise<void> {
    let next = 0;
    const lane = async () => {
      for (let t = targets[next++]; t; t = targets[next++]) {
        const target = t;
        try {
          const { port, scope } = this.#port(target.siteId, target.meshDomainId);
          const result = await port.requestPowerAction({
            siteId: target.siteId,
            upstream: { ...scope, meshNodeId: target.nodeId },
            type,
          });
          if (!result.accepted) {
            await this.db
              .update(powerActionTargets)
              .set({ status: 'failed', reason: result.reason, finishedAt: new Date(now), updatedAt: new Date(now) })
              .where(and(eq(powerActionTargets.deviceId, target.deviceId), eq(powerActionTargets.status, 'sent')));
          }
        } catch (err) {
          // Yuborilgan bo'lishi mumkin: target `sent` qoladi, natijani kuzatuv hal qiladi.
          const code = (err as { code?: unknown }).code;
          this.#log.warn(`power request failed${typeof code === 'string' ? `: ${code}` : ''}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, targets.length) }, lane));
  }

  #port(siteId: string, meshDomainId: string) {
    return requirePort(this.factory, this.config.meshInstanceId, { id: siteId, meshDomainId });
  }

  // site + node → snapshot; har site uchun bitta listDevices.
  async #snapshots(db: Db, siteIds: string[]): Promise<Map<string, DeviceSnapshot>> {
    const rows = await db.select().from(sites).where(inArray(sites.id, siteIds));
    const out = new Map<string, DeviceSnapshot>();
    for (const site of rows) {
      const { port } = requirePort(this.factory, this.config.meshInstanceId, site);
      for (const snap of await port.listDevices(site.id)) out.set(`${site.id}\u0000${snap.upstream.meshNodeId}`, snap);
    }
    return out;
  }

  async #reconcile(now: number): Promise<void> {
    if (!this.factory) return;
    const rows = await this.db
      .select({
        actionId: powerActionTargets.actionId,
        deviceId: powerActionTargets.deviceId,
        siteId: powerActionTargets.siteId,
        sentAt: powerActionTargets.sentAt,
        offlineSeenAt: powerActionTargets.offlineSeenAt,
        type: powerActions.type,
        nodeId: meshBindings.meshNodeId,
      })
      .from(powerActionTargets)
      .innerJoin(powerActions, eq(powerActions.id, powerActionTargets.actionId))
      .leftJoin(meshBindings, eq(meshBindings.deviceId, powerActionTargets.deviceId))
      .where(eq(powerActionTargets.status, 'sent'));
    if (rows.length === 0) return;
    const bySite = new Map<string, Map<string, DeviceSnapshot> | null>();
    for (const siteId of new Set(rows.map((r) => r.siteId))) {
      try {
        bySite.set(siteId, await this.#snapshots(this.db, [siteId]));
      } catch {
        // Kuzatib bo'lmadi: muddat baribir hisoblanadi (ma'lumotsiz holat — observation null).
        bySite.set(siteId, null);
      }
    }
    const at = new Date(now);
    for (const r of rows) {
      const snapshots = bySite.get(r.siteId);
      const snap = snapshots && r.nodeId !== null ? snapshots.get(`${r.siteId}\u0000${r.nodeId}`) : undefined;
      const observation = snap ? { agentOnline: snap.agentOnline, powerState: snap.powerState } : null;
      const prevOffline = r.offlineSeenAt?.getTime() ?? null;
      const judged = judgePowerTarget(
        r.type as PowerActionType,
        { sentAt: r.sentAt?.getTime() ?? now, offlineSeenAt: prevOffline },
        observation,
        now,
      );
      if (judged.status === 'sent' && judged.offlineSeenAt === prevOffline) continue;
      await this.db
        .update(powerActionTargets)
        .set({
          status: judged.status,
          offlineSeenAt: judged.offlineSeenAt === null ? null : new Date(judged.offlineSeenAt),
          finishedAt: judged.status === 'sent' ? null : at,
          updatedAt: at,
        })
        .where(
          and(
            eq(powerActionTargets.actionId, r.actionId),
            eq(powerActionTargets.deviceId, r.deviceId),
            eq(powerActionTargets.status, 'sent'),
          ),
        );
    }
  }

  async #finish(now: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const done = await tx
        .select()
        .from(powerActions)
        .where(
          and(
            eq(powerActions.status, 'running'),
            sql`not exists (select 1 from ${powerActionTargets} where ${powerActionTargets.actionId} = ${powerActions.id} and ${powerActionTargets.status} in ('pending', 'sent'))`,
          ),
        )
        .limit(ACTIONS_PER_TICK)
        .for('update', { skipLocked: true });
      for (const action of done) {
        await tx
          .update(powerActions)
          .set({ status: 'completed', completedAt: new Date(now) })
          .where(eq(powerActions.id, action.id));
        const counts = await tx
          .select({ status: powerActionTargets.status, n: sql<number>`count(*)::int` })
          .from(powerActionTargets)
          .where(eq(powerActionTargets.actionId, action.id))
          .groupBy(powerActionTargets.status);
        const summary = Object.fromEntries(POWER_TARGET_STATUSES.map((s) => [s, 0])) as Record<
          PowerTargetStatus,
          number
        >;
        for (const c of counts) summary[c.status as PowerTargetStatus] = c.n;
        await this.#systemAudit(tx, action, 'power.completed', summary);
      }
    });
  }

  #systemAudit(
    tx: Db,
    action: typeof powerActions.$inferSelect,
    name: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.write(
      tx,
      {
        organizationId: action.organizationId,
        siteId: action.siteIds.length === 1 ? (action.siteIds[0] ?? null) : null,
        actorUserId: null,
        action: name,
        targetType: 'power_action',
        targetId: action.id,
        result: 'succeeded',
        details: { type: action.type, ...details },
      },
      `power-${randomUUID()}`,
    );
  }
}
