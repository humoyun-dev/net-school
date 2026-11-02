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
import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { API_CONFIG, type ApiConfig } from '../../config/config.ts';
import { DB, type Db } from '../../db/client.ts';
import { meshBindings, powerActions, powerActionTargets, sites } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { DEVICE_MANAGEMENT, type DeviceManagementFactory, requirePort } from '../devices/mesh.ts';
import { MESH_LINK, type MeshLink } from '../health/health.controller.ts';
import { WORKERS_ENABLED } from '../workers/outbox.worker.ts';
import { PowerService } from './power.service.ts';
import { PowerSchedulesService } from './power-schedules.service.ts';

const INTERVAL_MS = 1_000;

// Tick davomida site snapshot'lari keshi (bitta site — bitta chaqiruv, parallel so'rovlar bitta va'dani kutadi).
class SnapshotCache {
  readonly #load: (siteId: string) => Promise<Map<string, DeviceSnapshot> | null>;
  readonly #cache = new Map<string, Promise<Map<string, DeviceSnapshot> | null>>();

  constructor(load: (siteId: string) => Promise<Map<string, DeviceSnapshot> | null>) {
    this.#load = load;
  }

  get(siteId: string): Promise<Map<string, DeviceSnapshot> | null> {
    let p = this.#cache.get(siteId);
    if (!p) {
      p = this.#load(siteId);
      this.#cache.set(siteId, p);
    }
    return p;
  }
}
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
    @Inject(PowerSchedulesService) private readonly schedules: PowerSchedulesService,
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
    // Bitta tick ichida har site uchun ko'pi bilan bitta listDevices (claim va kuzatuv umumiy).
    // Site qatorlari oldindan: snapshot claim tranzaksiyasi ichida olinadi, u yerda tashqi DB so'rovi bo'lmasin.
    const siteRows = new Map((await this.db.select().from(sites)).map((s) => [s.id, s]));
    const snapshots = new SnapshotCache((siteId) => this.#listSite(siteRows.get(siteId)));
    await this.schedules.runDue(now);
    await this.#startDue(now);
    await this.#dispatch(now, snapshots);
    await this.#reconcile(now, snapshots);
    await this.#finish(now);
  }

  // Har amal o'z tranzaksiyasida: bittasining xatosi boshqalarini to'smaydi.
  async #startDue(now: number): Promise<void> {
    const due = await this.db
      .select({ id: powerActions.id })
      .from(powerActions)
      .where(and(eq(powerActions.status, 'scheduled'), lte(powerActions.runAt, new Date(now))))
      .orderBy(asc(powerActions.runAt))
      .limit(ACTIONS_PER_TICK);
    for (const { id } of due) {
      try {
        await this.db.transaction(async (tx) => {
          const [action] = await tx
            .select()
            .from(powerActions)
            .where(and(eq(powerActions.id, id), eq(powerActions.status, 'scheduled')))
            .for('update', { skipLocked: true });
          if (!action) return;
          if (now - action.runAt.getTime() > POWER_MISSED_GRACE_MS) {
            await tx
              .update(powerActions)
              .set({ status: 'missed', completedAt: new Date(now) })
              .where(eq(powerActions.id, action.id));
            await this.#systemAudit(tx, action, 'power.missed', { runAt: action.runAt.toISOString() });
          } else {
            await this.power.materialize(tx, action.id, now);
          }
        });
      } catch (err) {
        this.#log.error(`power action ${id} could not start: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }

  async #dispatch(now: number, snapshots: SnapshotCache): Promise<void> {
    const at = new Date(now);
    const failed = { status: 'failed', reason: 'upstream_unavailable', finishedAt: at, updatedAt: at } as const;
    // To'lqin jadvali eskirgan amal (hub o'chiq bo'lgan yoki MeshCentral uzoq uzilgan): qolganlari kech
    // yuborilmaydi — darsda kutilmagan o'chirish/qayta yuklash bo'lmaydi.
    await this.db
      .update(powerActionTargets)
      .set(failed)
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
                  lt(powerActions.nextWaveAt, new Date(now - POWER_SEND_GIVE_UP_MS)),
                ),
              ),
          ),
        ),
      );
    // Snapshot'i uzoq olinmagan site targetlari.
    await this.db
      .update(powerActionTargets)
      .set(failed)
      .where(
        and(
          eq(powerActionTargets.status, 'pending'),
          lt(powerActionTargets.deferredSince, new Date(now - POWER_SEND_GIVE_UP_MS)),
        ),
      );
    if (!this.link?.connected || !this.factory) return;
    const skipped = new Set<string>();
    for (let i = 0; i < ACTIONS_PER_TICK; i++) {
      const wave = await this.#claimWave(now, skipped, snapshots);
      if (!wave) return;
      await this.#send(wave.actionId, wave.type, wave.targets, now);
    }
  }

  // Bitta amalning navbatdagi to'lqini: holat tekshiruvi, `sent` belgilanadi va commit. Keyin yuboriladi.
  // To'lqin (site, device) tartibida — odatda bitta site, ya'ni bitta snapshot.
  async #claimWave(
    now: number,
    skipped: Set<string>,
    snapshots: SnapshotCache,
  ): Promise<{ actionId: string; type: PowerActionType; targets: WaveTarget[] } | null> {
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
      const at = new Date(now);
      const rows = await tx
        .select({
          deviceId: powerActionTargets.deviceId,
          siteId: powerActionTargets.siteId,
          nodeId: meshBindings.meshNodeId,
          meshDomainId: meshBindings.meshDomainId,
        })
        .from(powerActionTargets)
        .leftJoin(meshBindings, eq(meshBindings.deviceId, powerActionTargets.deviceId))
        .where(
          and(
            eq(powerActionTargets.actionId, action.id),
            eq(powerActionTargets.status, 'pending'),
            or(isNull(powerActionTargets.retryAt), lte(powerActionTargets.retryAt, at)),
          ),
        )
        .orderBy(asc(powerActionTargets.siteId), asc(powerActionTargets.deviceId))
        .limit(POWER_WAVE_SIZE)
        .for('update', { of: powerActionTargets, skipLocked: true });
      await tx
        .update(powerActions)
        .set({ nextWaveAt: new Date(now + POWER_WAVE_INTERVAL_MS) })
        .where(eq(powerActions.id, action.id));
      const toSend: WaveTarget[] = [];
      const set = (deviceIds: string[], values: Partial<typeof powerActionTargets.$inferInsert>) =>
        deviceIds.length === 0
          ? Promise.resolve()
          : tx
              .update(powerActionTargets)
              .set({ ...values, updatedAt: at })
              .where(and(eq(powerActionTargets.actionId, action.id), inArray(powerActionTargets.deviceId, deviceIds)));
      for (const siteId of [...new Set(rows.map((r) => r.siteId))]) {
        const here = rows.filter((r) => r.siteId === siteId);
        const snap = await snapshots.get(siteId);
        if (!snap) {
          // Shu site kuzatilmadi: faqat uning targetlari kechiktiriladi, boshqa site'lar davom etadi.
          await tx
            .update(powerActionTargets)
            .set({
              retryAt: new Date(now + POWER_WAVE_INTERVAL_MS),
              deferredSince: sql`coalesce(${powerActionTargets.deferredSince}, ${at.toISOString()}::timestamptz)`,
              updatedAt: at,
            })
            .where(
              and(
                eq(powerActionTargets.actionId, action.id),
                inArray(
                  powerActionTargets.deviceId,
                  here.map((r) => r.deviceId),
                ),
              ),
            );
          continue;
        }
        const unbound: string[] = [];
        const offline: string[] = [];
        const awake: string[] = [];
        const sent: string[] = [];
        for (const r of here) {
          if (r.nodeId === null || r.meshDomainId === null) {
            // Amal boshlangandan keyin bog'lanish olib tashlangan.
            unbound.push(r.deviceId);
            continue;
          }
          const online = snap.get(r.nodeId)?.agentOnline === true;
          if (type === 'wake' && online) awake.push(r.deviceId);
          else if (type !== 'wake' && !online) offline.push(r.deviceId);
          else {
            sent.push(r.deviceId);
            toSend.push({ deviceId: r.deviceId, siteId, nodeId: r.nodeId, meshDomainId: r.meshDomainId });
          }
        }
        await set(unbound, { status: 'failed', reason: 'unbound', finishedAt: at });
        await set(offline, { status: 'failed', reason: 'device_offline', finishedAt: at });
        await set(awake, { status: 'succeeded', finishedAt: at });
        await set(sent, { status: 'sent', sentAt: at, retryAt: null, deferredSince: null });
      }
      return { actionId: action.id, type, targets: toSend };
    });
  }

  async #send(actionId: string, type: PowerActionType, targets: WaveTarget[], now: number): Promise<void> {
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
            const at = new Date(Math.max(now, this.now()));
            await this.db
              .update(powerActionTargets)
              .set({ status: 'failed', reason: result.reason, finishedAt: at, updatedAt: at })
              .where(
                and(
                  eq(powerActionTargets.actionId, actionId),
                  eq(powerActionTargets.deviceId, target.deviceId),
                  eq(powerActionTargets.status, 'sent'),
                ),
              );
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

  // node → snapshot (bitta site); MeshCentral sozlanmagan yoki javob bermasa null. DB'ga murojaat qilmaydi.
  async #listSite(site: typeof sites.$inferSelect | undefined): Promise<Map<string, DeviceSnapshot> | null> {
    if (!site) return null;
    try {
      const { port } = requirePort(this.factory, this.config.meshInstanceId, site);
      return new Map((await port.listDevices(site.id)).map((s) => [s.upstream.meshNodeId, s]));
    } catch {
      return null;
    }
  }

  async #reconcile(now: number, snapshots: SnapshotCache): Promise<void> {
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
    const at = new Date(now);
    for (const r of rows) {
      // Kuzatib bo'lmasa (snapshot null) ham muddat hisoblanadi: observation null.
      const snap = await snapshots.get(r.siteId);
      const node = snap && r.nodeId !== null ? snap.get(r.nodeId) : undefined;
      const observation = node ? { agentOnline: node.agentOnline, powerState: node.powerState } : null;
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
