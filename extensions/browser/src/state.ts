import {
  type EffectiveBaseline,
  type EffectiveWeb,
  effectiveWeb,
  type LessonDocument,
  type UrlPattern,
} from '@netschool/domain';

// chrome.storage maydonining minimal porti (testda xotira).
export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PolicyMessage {
  type: 'policy';
  baseline: { revision: { org: number; site: number }; hash: string; blocked: UrlPattern[] } | null;
  lesson: { lessonId: string; version: number; hash: string; web: LessonDocument['web']; expiresInMs: number } | null;
}

export interface Effective {
  web: EffectiveWeb;
  baselineHash: string | null;
  lessonHash: string | null;
}

interface StoredBaseline {
  hash: string;
  blocked: UrlPattern[];
}
interface StoredLesson {
  hash: string;
  web: LessonDocument['web'];
  receivedAt: number;
  deadline: number;
}

const BASELINE_KEY = 'baseline';
const LESSON_KEY = 'lesson';

// Bazaviy qatlam `storage.local`da (brauzer qayta ochilsa ham qoladi), dars qatlami `storage.session`da (brauzer
// qayta ochilsa yo'qoladi — spec §10: muddati o'tgan dars cheklovi qayta qo'llanmaydi). Dars muddati Companion bergan
// qolgan vaqt bo'yicha; soat orqaga surilsa (now < receivedAt) dars qatlami tashlanadi.
export class PolicyState {
  constructor(
    private readonly store: { local: KV; session: KV },
    private readonly now: () => number,
  ) {}

  async onPolicy(msg: PolicyMessage): Promise<Effective> {
    if (msg.baseline) {
      const b: StoredBaseline = { hash: msg.baseline.hash, blocked: msg.baseline.blocked };
      await this.store.local.set(BASELINE_KEY, b);
    }
    if (msg.lesson) {
      const at = this.now();
      const l: StoredLesson = {
        hash: msg.lesson.hash,
        web: msg.lesson.web,
        receivedAt: at,
        deadline: at + Math.max(0, msg.lesson.expiresInMs),
      };
      await this.store.session.set(LESSON_KEY, l);
    } else {
      await this.store.session.remove(LESSON_KEY);
    }
    return this.effective();
  }

  async effective(): Promise<Effective> {
    const b = (await this.store.local.get(BASELINE_KEY)) as StoredBaseline | undefined;
    let l = (await this.store.session.get(LESSON_KEY)) as StoredLesson | undefined;
    const now = this.now();
    if (l && (now < l.receivedAt || now >= l.deadline)) {
      await this.store.session.remove(LESSON_KEY);
      l = undefined;
    }
    const baseline: EffectiveBaseline = {
      web: { blocked: b?.blocked ?? [] },
      browser: { managed: true, incognito: 'disabled', devTools: 'disabled' },
      os: { standardUser: false, blockAppInstall: false, lockWallpaper: false },
    };
    const lesson: LessonDocument | null = l ? { schemaVersion: 1, web: l.web } : null;
    return { web: effectiveWeb(baseline, lesson), baselineHash: b?.hash ?? null, lessonHash: l?.hash ?? null };
  }
}
