import { Inject, Injectable } from '@nestjs/common';
import type {
  BaselineRevision,
  DevicePolicy,
  HelperPolicy,
  PolicyHint,
  PolicyReceipt,
  PolicyStatus,
} from '@netschool/contracts';
import {
  activeRules,
  type EffectiveBaseline,
  type LessonDocument,
  type PolicyReporter,
  type RuleKey,
  receiptStatus,
} from '@netschool/domain';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { API_CONFIG, type ApiConfig } from '../../config/config.ts';
import { DB, type Db } from '../../db/client.ts';
import { devices, lessonDevices, lessons, policyAssignments, policyReceipts, rooms } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { PolicyService } from './policy.service.ts';

// Qurilma (Companion/Helper) identifikatsiyasi — imzo guard'idan; hech qachon so'rov maydonidan emas.
export interface PolicyDevice {
  id: string;
  organizationId: string;
  siteId: string;
}

// Spec §10: dars qatlami lease'i overlay bilan bir xil.
export const LESSON_POLICY_LEASE_SECONDS = 120;
// Shundan eski receipt holatni tasdiqlamaydi (Helper o'zgarmagan receipt'ni har 300 s, Companion har 60 s yuboradi).
export const RECEIPT_STALE_MS = 15 * 60_000;

type LayerStatus = 'applied' | 'partial' | 'failed' | 'pending';
type ReceiptRow = typeof policyReceipts.$inferSelect;
type Rules = Partial<Record<RuleKey, { state: 'applied' | 'failed' | 'unsupported'; code?: string }>>;

const WORST: LayerStatus[] = ['failed', 'partial', 'pending', 'applied'];
const worst = (list: LayerStatus[]): LayerStatus => WORST.find((s) => list.includes(s)) ?? 'applied';

// Bazaviy revision orqaga ketmaydi: har komponent alohida monoton.
const olderBaseline = (next: BaselineRevision, stored: BaselineRevision) =>
  next.org < stored.org || next.site < stored.site;

@Injectable()
export class PolicyDeliveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(PolicyService) private readonly policies: PolicyService,
  ) {}

  // Faqat versiya raqamlari (hujjatsiz): heartbeat va lock-state har 5–10 s chaqiradi.
  async baselineRevision(organizationId: string, siteId: string): Promise<BaselineRevision> {
    const rows = await this.db
      .select({ siteId: policyAssignments.siteId, version: policyAssignments.version })
      .from(policyAssignments)
      .where(
        and(
          eq(policyAssignments.organizationId, organizationId),
          eq(policyAssignments.layer, 'baseline'),
          isNull(policyAssignments.lessonId),
        ),
      );
    return {
      org: rows.find((r) => r.siteId === null)?.version ?? 0,
      site: rows.find((r) => r.siteId === siteId)?.version ?? 0,
    };
  }

  async hintOf(device: PolicyDevice, lessonId: string | null): Promise<PolicyHint> {
    const baseline = await this.baselineRevision(device.organizationId, device.siteId);
    const lesson = lessonId ? await this.policies.lessonLayerOf(device.organizationId, device.siteId, lessonId) : null;
    return { baseline, lesson: lesson && lessonId ? { lessonId, version: lesson.version } : null };
  }

  async devicePolicy(device: PolicyDevice): Promise<DevicePolicy> {
    const baseline = await this.policies.effectiveBaseline(device.organizationId, device.siteId);
    const lessonId = await this.#activeLessonOf(device.id);
    const layer = lessonId ? await this.policies.lessonLayerOf(device.organizationId, device.siteId, lessonId) : null;
    return {
      baseline,
      lesson:
        layer && lessonId
          ? {
              lessonId,
              version: layer.version,
              hash: layer.contentHash,
              document: layer.document,
              leaseSeconds: LESSON_POLICY_LEASE_SECONDS,
            }
          : null,
    };
  }

  async helperPolicy(device: PolicyDevice): Promise<HelperPolicy> {
    const baseline = await this.policies.effectiveBaseline(device.organizationId, device.siteId);
    return { baseline, extensions: this.config.extensionIds ?? { chrome: null, edge: null } };
  }

  // Receipt saqlanadi (xabar beruvchi bo'yicha alohida); eski versiya natijasi yangisini bosmaydi.
  async recordReceipt(
    device: PolicyDevice,
    reporter: PolicyReporter,
    receipt: PolicyReceipt,
    correlationId: string,
  ): Promise<void> {
    if (reporter === 'helper' && receipt.layer !== 'baseline') throw new ApiError('validation_failed');
    const applied =
      receipt.layer === 'baseline' ? receipt.revision : { lessonId: receipt.lessonId, version: receipt.version };
    const at = new Date(this.now());
    await this.db.transaction(async (tx) => {
      const key = and(
        eq(policyReceipts.deviceId, device.id),
        eq(policyReceipts.layer, receipt.layer),
        eq(policyReceipts.reporter, reporter),
      );
      const [stored] = await tx.select().from(policyReceipts).where(key).for('update');
      if (stored && this.#isOlder(receipt, stored)) return;
      const values = {
        applied,
        contentHash: receipt.hash,
        rules: receipt.rules,
        repaired: receipt.layer === 'baseline' ? (receipt.repaired ?? []) : [],
        reportedAt: at,
      };
      if (stored) await tx.update(policyReceipts).set(values).where(key);
      else
        await tx.insert(policyReceipts).values({
          organizationId: device.organizationId,
          siteId: device.siteId,
          deviceId: device.id,
          layer: receipt.layer,
          reporter,
          ...values,
        });
      if (receipt.layer === 'baseline' && receipt.repaired && receipt.repaired.length > 0) {
        await this.audit.write(
          tx,
          {
            organizationId: device.organizationId,
            siteId: device.siteId,
            actorUserId: null,
            action: 'policy.drift_repaired',
            targetType: 'device',
            targetId: device.id,
            result: 'succeeded',
            details: { reporter, rules: receipt.repaired, revision: receipt.revision },
          },
          correlationId,
        );
      }
    });
  }

  // Panel: xona yoki site qurilmalari bo'yicha desired/applied (spec §8: "30 tadan 29" umumlashtirilmaydi).
  async status(ctx: RequestContext, query: { roomId: string | null; siteId: string | null }): Promise<PolicyStatus> {
    const actor = this.access.actor(ctx);
    const target = await this.#statusTarget(ctx, actor.organizationId, query);
    const rows = await this.db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(
        and(
          eq(devices.organizationId, actor.organizationId),
          eq(devices.siteId, target.siteId),
          target.roomId ? eq(devices.roomId, target.roomId) : undefined,
          isNull(devices.retiredAt),
        ),
      );
    if (rows.length === 0) return { devices: [] };
    const baseline = await this.policies.effectiveBaseline(actor.organizationId, target.siteId);
    const ids = rows.map((r) => r.id);
    const receipts = await this.db.select().from(policyReceipts).where(inArray(policyReceipts.deviceId, ids));
    const lessonsOf = await this.#activeLessonsOf(ids);
    const layers = new Map<string, Awaited<ReturnType<PolicyService['lessonLayerOf']>>>();
    for (const lessonId of new Set(lessonsOf.values())) {
      layers.set(lessonId, await this.policies.lessonLayerOf(actor.organizationId, target.siteId, lessonId));
    }
    return {
      devices: rows.map((d) => {
        const mine = receipts.filter((r) => r.deviceId === d.id);
        const pick = (layer: string, reporter: string) =>
          mine.find((r) => r.layer === layer && r.reporter === reporter) ?? null;
        const companion = pick('baseline', 'companion');
        const helper = pick('baseline', 'helper');
        const baselineStatus = worst([
          this.#layerStatus(baseline.document, 'baseline', 'companion', baseline.hash, companion, () => true),
          this.#layerStatus(baseline.document, 'baseline', 'helper', baseline.hash, helper, () => true),
        ]);
        const lessonId = lessonsOf.get(d.id);
        const layer = lessonId ? layers.get(lessonId) : null;
        const lessonReceipt = pick('lesson', 'companion');
        return {
          deviceId: d.id,
          baseline: {
            desired: baseline.revision,
            companion: view(companion, baseline.document, 'baseline', 'companion'),
            helper: view(helper, baseline.document, 'baseline', 'helper'),
            status: baselineStatus,
          },
          lesson:
            layer && lessonId
              ? {
                  desired: { lessonId, version: layer.version },
                  companion: view(lessonReceipt, layer.document, 'lesson', 'companion'),
                  status: this.#layerStatus(
                    layer.document,
                    'lesson',
                    'companion',
                    layer.contentHash,
                    lessonReceipt,
                    // Bir xil allowlist'li yangi dars eski darsning receipt'ini meros qilmaydi.
                    (applied) => {
                      const a = applied as { lessonId?: string; version?: number };
                      return a.lessonId === lessonId && a.version === layer.version;
                    },
                  ),
                }
              : null,
        };
      }),
    };
  }

  #layerStatus(
    doc: EffectiveBaseline | LessonDocument,
    layer: 'baseline' | 'lesson',
    reporter: PolicyReporter,
    desiredHash: string,
    receipt: ReceiptRow | null,
    matches: (applied: unknown) => boolean,
  ): LayerStatus {
    const expected = activeRules(layer, doc, reporter);
    if (expected.length === 0) return 'applied';
    if (!receipt || receipt.contentHash !== desiredHash || !matches(receipt.applied)) return 'pending';
    if (this.now() - receipt.reportedAt.getTime() > RECEIPT_STALE_MS) return 'pending';
    return receiptStatus(expected, receipt.rules as Rules);
  }

  #isOlder(receipt: PolicyReceipt, stored: ReceiptRow): boolean {
    if (receipt.layer === 'baseline') return olderBaseline(receipt.revision, stored.applied as BaselineRevision);
    const prev = stored.applied as { lessonId: string; version: number };
    return prev.lessonId === receipt.lessonId && receipt.version < prev.version;
  }

  async #statusTarget(
    ctx: RequestContext,
    organizationId: string,
    query: { roomId: string | null; siteId: string | null },
  ): Promise<{ siteId: string; roomId: string | null }> {
    const on = { targetType: query.roomId ? 'room' : 'site', targetId: query.roomId ?? query.siteId ?? '' };
    if (query.roomId) {
      const [room] = isUuid(query.roomId)
        ? await this.db
            .select({ siteId: rooms.siteId })
            .from(rooms)
            .where(and(eq(rooms.id, query.roomId), eq(rooms.organizationId, organizationId)))
        : [];
      if (!room) return this.access.deny(ctx, 'policy.read', on);
      await this.access.require(ctx, 'policy.read', { organizationId, siteId: room.siteId, roomId: query.roomId }, on);
      return { siteId: room.siteId, roomId: query.roomId };
    }
    if (!query.siteId || !isUuid(query.siteId)) throw new ApiError('validation_failed');
    await this.access.require(ctx, 'policy.read', { organizationId, siteId: query.siteId }, on);
    return { siteId: query.siteId, roomId: null };
  }

  async #activeLessonOf(deviceId: string): Promise<string | null> {
    return (await this.#activeLessonsOf([deviceId])).get(deviceId) ?? null;
  }

  // Lesson qatlami qurilma faol dars a'zosi bo'lsa amalda (overlay qulfiga bog'liq emas).
  async #activeLessonsOf(deviceIds: string[]): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ deviceId: lessonDevices.deviceId, lessonId: lessonDevices.lessonId })
      .from(lessonDevices)
      .innerJoin(lessons, eq(lessons.id, lessonDevices.lessonId))
      .where(
        and(inArray(lessonDevices.deviceId, deviceIds), isNull(lessonDevices.releasedAt), eq(lessons.status, 'active')),
      );
    return new Map(rows.map((r) => [r.deviceId, r.lessonId]));
  }
}

function view(
  row: ReceiptRow | null,
  doc: EffectiveBaseline | LessonDocument,
  layer: 'baseline' | 'lesson',
  reporter: PolicyReporter,
) {
  if (!row) return null;
  const rules = row.rules as Rules;
  return {
    applied: row.applied,
    status: receiptStatus(activeRules(layer, doc, reporter), rules),
    rules,
    reportedAt: row.reportedAt.toISOString(),
  };
}
