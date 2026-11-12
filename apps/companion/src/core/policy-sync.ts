import { type DevicePolicy, devicePolicySchema, type PolicyHint, type PolicyReceipt } from '@netschool/contracts';
import type { LessonDocument, UrlPattern } from '@netschool/domain';
import type { StateCache } from './cache.ts';
import type { MonotonicClock } from './clock.ts';
import type { HubClient } from './hub-client.ts';

// P2c: hub siyosatini qurilmada yuritish. Bazaviy qatlam keshlanadi (oflayn qoladi), dars qatlami faqat monoton lease
// ichida (spec §10: rebootdan keyin qayta qo'llanmaydi). Web qoidalarini extension qo'llaydi; receipt faqat extension
// shu hash'ni tasdiqlaganda `applied`.

export type CachedBaseline = DevicePolicy['baseline'];

export interface WebPolicyPush {
  baseline: { revision: CachedBaseline['revision']; hash: string; blocked: UrlPattern[] } | null;
  lesson: { lessonId: string; version: number; hash: string; web: LessonDocument['web']; expiresInMs: number } | null;
}

export interface ExtensionReport {
  browser: 'chrome' | 'edge';
  extensionVersion: string;
  baselineHash: string | null;
  lessonHash: string | null;
}

export interface PolicySyncDeps {
  fetch(): Promise<DevicePolicy>;
  sendReceipt(receipt: PolicyReceipt): Promise<void>;
  store: { load(): CachedBaseline | null; save(baseline: CachedBaseline): void };
  clock: { nowMs(): number };
  onChange(push: WebPolicyPush): void;
}

// Extension tasdig'i shu muddat ichida "tirik"; receipt o'zgarmasa ham shu oraliqda qayta yuboriladi.
export const EXTENSION_FRESH_MS = 60_000;
export const RECEIPT_REFRESH_MS = 60_000;

interface ActiveLesson {
  layer: NonNullable<DevicePolicy['lesson']>;
  expiresAt: number;
}

export class PolicySync {
  readonly #deps: PolicySyncDeps;
  #baseline: CachedBaseline | null;
  #lesson: ActiveLesson | null = null;
  readonly #reports = new Map<string, ExtensionReport & { at: number }>();
  readonly #sent = new Map<string, { key: string; at: number }>();

  constructor(deps: PolicySyncDeps) {
    this.#deps = deps;
    this.#baseline = deps.store.load();
  }

  // Heartbeat ishorasi: versiya o'zgarsa to'liq siyosat olinadi; bir xil bo'lsa dars lease'i yangilanadi.
  async onHint(hint: PolicyHint | undefined): Promise<void> {
    if (!hint) return;
    const baselineChanged =
      !this.#baseline ||
      this.#baseline.revision.org !== hint.baseline.org ||
      this.#baseline.revision.site !== hint.baseline.site;
    const lessonChanged =
      hint.lesson !== null &&
      (this.#lesson?.layer.lessonId !== hint.lesson.lessonId || this.#lesson.layer.version !== hint.lesson.version);
    if (hint.lesson === null && this.#lesson) {
      this.#lesson = null;
      this.#emit();
    }
    if (baselineChanged || lessonChanged) {
      const policy = await this.#deps.fetch();
      this.#baseline = policy.baseline;
      this.#deps.store.save(policy.baseline);
      this.#lesson = policy.lesson ? { layer: policy.lesson, expiresAt: this.#expiry(policy.lesson) } : null;
      this.#emit();
      return;
    }
    if (this.#lesson && hint.lesson) this.#lesson.expiresAt = this.#expiry(this.#lesson.layer);
  }

  onExtensionReport(report: ExtensionReport): void {
    this.#reports.set(report.browser, { ...report, at: this.#deps.clock.nowMs() });
  }

  // Har soniya (overlay tick bilan): lease muddati va receipt'lar.
  async tick(): Promise<void> {
    if (this.#lesson && this.#deps.clock.nowMs() >= this.#lesson.expiresAt) {
      this.#lesson = null;
      this.#emit();
    }
    for (const receipt of this.#receipts()) await this.#send(receipt);
  }

  current(): WebPolicyPush {
    const now = this.#deps.clock.nowMs();
    const b = this.#baseline;
    const l = this.#lesson;
    return {
      baseline: b ? { revision: b.revision, hash: b.hash, blocked: b.document.web.blocked } : null,
      lesson: l
        ? {
            lessonId: l.layer.lessonId,
            version: l.layer.version,
            hash: l.layer.hash,
            web: l.layer.document.web,
            expiresInMs: Math.max(0, l.expiresAt - now),
          }
        : null,
    };
  }

  webFilterState(): 'available' | 'requires_setup' {
    return this.#fresh().length > 0 ? 'available' : 'requires_setup';
  }

  #expiry(layer: NonNullable<DevicePolicy['lesson']>): number {
    return this.#deps.clock.nowMs() + layer.leaseSeconds * 1000;
  }

  #fresh() {
    const now = this.#deps.clock.nowMs();
    return [...this.#reports.values()].filter((r) => now - r.at <= EXTENSION_FRESH_MS);
  }

  // Qoida natijasi: extension yo'q → failed; birortasi joriy hash'ni tasdiqlagan → applied; aks holda null (kutish).
  #rule(hash: string, pick: (r: ExtensionReport) => string | null) {
    const fresh = this.#fresh();
    if (fresh.length === 0) return { state: 'failed' as const, code: 'extension_missing' };
    return fresh.some((r) => pick(r) === hash) ? { state: 'applied' as const } : null;
  }

  #receipts(): PolicyReceipt[] {
    const out: PolicyReceipt[] = [];
    const b = this.#baseline;
    if (b) {
      const rules: Extract<PolicyReceipt, { layer: 'baseline' }>['rules'] = {};
      let ready = true;
      if (b.document.web.blocked.length > 0) {
        const r = this.#rule(b.hash, (x) => x.baselineHash);
        if (r) rules['web.blocked'] = r;
        else ready = false;
      }
      if (ready) out.push({ layer: 'baseline', revision: b.revision, hash: b.hash, rules });
    }
    const l = this.#lesson?.layer;
    if (l) {
      const rules: Extract<PolicyReceipt, { layer: 'lesson' }>['rules'] = {};
      let ready = true;
      if (l.document.web.mode !== 'off') {
        const r = this.#rule(l.hash, (x) => x.lessonHash);
        if (r) rules['web.lesson'] = r;
        else ready = false;
      }
      if (ready) out.push({ layer: 'lesson', lessonId: l.lessonId, version: l.version, hash: l.hash, rules });
    }
    return out;
  }

  async #send(receipt: PolicyReceipt): Promise<void> {
    const key = JSON.stringify(receipt);
    const now = this.#deps.clock.nowMs();
    const last = this.#sent.get(receipt.layer);
    if (last && last.key === key && now - last.at < RECEIPT_REFRESH_MS) return;
    await this.#deps.sendReceipt(receipt);
    this.#sent.set(receipt.layer, { key, at: now });
  }

  #emit(): void {
    this.#deps.onChange(this.current());
  }
}

// Haqiqiy hub va SQLite kesh bilan bog'lash (main va integratsion testlar).
export function hubPolicyDeps(
  hub: HubClient,
  cache: StateCache,
  clock: Pick<MonotonicClock, 'nowMs'>,
  onChange: (push: WebPolicyPush) => void,
): PolicySyncDeps {
  return {
    fetch: () => hub.json('GET', '/api/v1/device/policy', undefined, devicePolicySchema),
    sendReceipt: async (receipt) => {
      await hub.json('PUT', '/api/v1/device/policy/receipt', receipt, null);
    },
    store: { load: () => cache.loadBaseline(), save: (b) => cache.saveBaseline(b) },
    clock,
    onChange,
  };
}
