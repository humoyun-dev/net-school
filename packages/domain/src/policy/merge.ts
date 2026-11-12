import type { UrlPattern } from './url-pattern.ts';

// Bazaviy qatlam hujjati (tashkilot yoki site). Maydon yo'q — shu ko'lam hech narsa qo'shmaydi.
export interface BaselineDocument {
  schemaVersion: 1;
  web?: { blocked: UrlPattern[] };
  browser?: { managed?: boolean; incognito?: 'allowed' | 'disabled'; devTools?: 'allowed' | 'disabled' };
  os?: { standardUser?: boolean; blockAppInstall?: boolean; lockWallpaper?: boolean };
}

export interface EffectiveBaseline {
  web: { blocked: UrlPattern[] };
  browser: { managed: boolean; incognito: 'allowed' | 'disabled'; devTools: 'allowed' | 'disabled' };
  os: { standardUser: boolean; blockAppInstall: boolean; lockWallpaper: boolean };
}

export interface LessonDocument {
  schemaVersion: 1;
  web: { mode: 'off' | 'allowlist' | 'blocklist'; patterns: UrlPattern[] };
}

export interface EffectiveWeb {
  block: UrlPattern[];
  // null bo'lmasa faqat shular ruxsat etiladi; `block` baribir ustun.
  allowOnly: UrlPattern[] | null;
}

export type RuleKey =
  | 'web.blocked'
  | 'web.lesson'
  | 'browser.managed'
  | 'browser.incognito'
  | 'browser.devTools'
  | 'browser.onlyManaged'
  | 'os.standardUser'
  | 'os.blockAppInstall'
  | 'os.lockWallpaper';

export type PolicyLayer = 'baseline' | 'lesson';
export type PolicyReporter = 'companion' | 'helper';
export type RuleState = 'applied' | 'failed' | 'unsupported';
export type ReceiptStatus = 'applied' | 'partial' | 'failed';

const union = (...lists: (readonly UrlPattern[] | undefined)[]): UrlPattern[] =>
  [...new Set(lists.flatMap((l) => l ?? []))].sort();

const disabled = (...v: ('allowed' | 'disabled' | undefined)[]) => (v.includes('disabled') ? 'disabled' : 'allowed');

// Qattiqrog'i yutadi: site tashkilot cheklovini bo'shata olmaydi (spec §10, dizayn §4.2).
export function mergeBaseline(org: BaselineDocument | null, site: BaselineDocument | null): EffectiveBaseline {
  const docs = [org, site].filter((d): d is BaselineDocument => d !== null);
  const any = (pick: (d: BaselineDocument) => boolean | undefined) => docs.some((d) => pick(d) === true);
  return {
    web: { blocked: union(...docs.map((d) => d.web?.blocked)) },
    browser: {
      managed: any((d) => d.browser?.managed),
      incognito: disabled(...docs.map((d) => d.browser?.incognito)),
      devTools: disabled(...docs.map((d) => d.browser?.devTools)),
    },
    os: {
      standardUser: any((d) => d.os?.standardUser),
      blockAppInstall: any((d) => d.os?.blockAppInstall),
      lockWallpaper: any((d) => d.os?.lockWallpaper),
    },
  };
}

// Brauzerda qo'llanadigan natija: bazaviy blok doim ustun, dars faqat qo'shimcha cheklaydi.
export function effectiveWeb(baseline: EffectiveBaseline, lesson: LessonDocument | null): EffectiveWeb {
  const mode = lesson?.web.mode ?? 'off';
  if (mode === 'blocklist') return { block: union(baseline.web.blocked, lesson?.web.patterns), allowOnly: null };
  if (mode === 'allowlist') return { block: union(baseline.web.blocked), allowOnly: [...(lesson?.web.patterns ?? [])] };
  return { block: union(baseline.web.blocked), allowOnly: null };
}

// Xabar beruvchi shu qatlam hujjatida qaysi faol qoidalar uchun javob beradi.
export function activeRules(
  layer: PolicyLayer,
  doc: EffectiveBaseline | LessonDocument,
  reporter: PolicyReporter,
): RuleKey[] {
  if (layer === 'lesson') {
    return reporter === 'companion' && (doc as LessonDocument).web.mode !== 'off' ? ['web.lesson'] : [];
  }
  const b = doc as EffectiveBaseline;
  const rules: RuleKey[] = [];
  if (reporter === 'companion') {
    if (b.web.blocked.length > 0) rules.push('web.blocked');
    return rules;
  }
  if (b.browser.managed) rules.push('browser.managed', 'browser.onlyManaged');
  if (b.browser.incognito === 'disabled') rules.push('browser.incognito');
  if (b.browser.devTools === 'disabled') rules.push('browser.devTools');
  if (b.os.standardUser) rules.push('os.standardUser');
  if (b.os.blockAppInstall) rules.push('os.blockAppInstall');
  if (b.os.lockWallpaper) rules.push('os.lockWallpaper');
  return rules;
}

// Kutilgan qoidalar bo'yicha umumiy natija; `unsupported` qo'llangan hisoblanmaydi.
export function receiptStatus(
  expected: readonly RuleKey[],
  rules: Partial<Record<RuleKey, { state: RuleState }>>,
): ReceiptStatus {
  if (expected.length === 0) return 'applied';
  const applied = expected.filter((k) => rules[k]?.state === 'applied').length;
  if (applied === expected.length) return 'applied';
  return applied === 0 ? 'failed' : 'partial';
}
