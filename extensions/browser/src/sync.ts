import { isBlocked, MAX_PATTERNS_PER_REGEX, toDnrRules } from './rules.ts';
import type { Effective, PolicyMessage, PolicyState } from './state.ts';

export interface SyncDeps {
  state: PolicyState;
  dnr: {
    get(): Promise<{ id: number }[]>;
    update(options: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>;
  };
  post(message: unknown): void;
  browser: 'chrome' | 'edge';
  version: string;
}

// Extension holati: siyosatni DNR'ga o'rnatadi, o'rnatilganini tekshiradi va Companion'ga har push'da hamda har
// tick'da (30 s) tasdiq yuboradi — Companion tasdiqni 60 s "tirik" deb hisoblaydi.
export class ExtensionSync {
  // current — navigatsiya tekshiruvi (darhol, DNR yiqilsa ham); installed — DNR'da tasdiqlangan holat.
  #current: Effective | null = null;
  #installed: { baselineHash: string | null; lessonHash: string | null; rules: string } | null = null;

  constructor(private readonly d: SyncDeps) {}

  async onPolicy(msg: PolicyMessage): Promise<void> {
    await this.d.state.onPolicy(msg);
    await this.tick();
  }

  async tick(): Promise<void> {
    const eff = await this.d.state.effective();
    const i = this.#installed;
    const same =
      i !== null &&
      i.baselineHash === eff.baselineHash &&
      i.lessonHash === eff.lessonHash &&
      i.rules === JSON.stringify(eff.web);
    if (!same) await this.#apply(eff);
    this.#ack();
  }

  blocked(url: string): boolean {
    return this.#current !== null && isBlocked(this.#current.web, url);
  }

  async #install(eff: Effective, groupSize: number): Promise<number> {
    const rules = toDnrRules(eff.web, groupSize);
    const existing = await this.d.dnr.get();
    await this.d.dnr.update({ removeRuleIds: existing.map((r) => r.id), addRules: rules });
    return rules.length;
  }

  async #apply(eff: Effective): Promise<void> {
    this.#current = eff;
    this.#installed = null;
    let expected: number;
    try {
      expected = await this.#install(eff, MAX_PATTERNS_PER_REGEX);
    } catch {
      // Regex guruhi RE2 chegarasidan oshgan bo'lishi mumkin: har pattern alohida qoida bilan.
      expected = await this.#install(eff, 1);
    }
    if ((await this.d.dnr.get()).length !== expected) throw new Error('dnr rules mismatch');
    this.#installed = { baselineHash: eff.baselineHash, lessonHash: eff.lessonHash, rules: JSON.stringify(eff.web) };
  }

  #ack(): void {
    if (!this.#installed) return;
    this.d.post({
      type: 'applied',
      browser: this.d.browser,
      extensionVersion: this.d.version,
      baselineHash: this.#installed.baselineHash,
      lessonHash: this.#installed.lessonHash,
    });
  }
}
