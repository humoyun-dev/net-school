import { type EffectiveWeb, matchesUrl, type UrlPattern } from '@netschool/domain';

// declarativeNetRequest qoidasi (faqat ishlatiladigan maydonlar).
export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'block' | 'allow' | 'redirect'; redirect?: { extensionPath: string } };
  condition: {
    requestDomains?: string[];
    regexFilter?: string;
    urlFilter?: string;
    isUrlFilterCaseSensitive?: boolean;
    resourceTypes?: ('main_frame' | 'sub_frame' | 'image')[];
  };
}

// Bitta regex'dagi pattern soni: DNR regex qoidalari soni (≤1000) va RE2 xotira chegarasi ichida qolish uchun.
export const MAX_PATTERNS_PER_REGEX = 20;

export const BLOCKED_PAGE = '/blocked.html';

// Ustuvorlik: blok (bazaviy va dars) > allowlist ruxsati > allowlist'dan tashqari hammasi.
const PRIORITY_BLOCK = 3;
const PRIORITY_ALLOW = 2;
const PRIORITY_CATCH_ALL = 1;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pattern → regex bo'lagi. Host: `*.` subdomenlar bilan; yo'l: segmentlar orasida takroriy `/` va registr farqi
// chetlab o'tishga yordam bermaydi (domain canonicalPath bilan bir xil ma'no). %-kodlangan yo'llar uchun
// background navigatsiya tekshiruvi (matchesUrl) qo'shimcha himoya.
function fragment(pattern: UrlPattern): string {
  const wildcard = pattern.startsWith('*.');
  const body = wildcard ? pattern.slice(2) : pattern;
  const slash = body.indexOf('/');
  const host = slash < 0 ? body : body.slice(0, slash);
  const path = slash < 0 ? '' : body.slice(slash);
  const hostRe = `${wildcard ? '([^/?#]*\\.)?' : ''}${escapeRe(host)}\\.?(:\\d+)?`;
  const segments = path.split('/').filter((s) => s !== '');
  // Chegara pattern ichida: host'dan keyin faqat [/?#] yoki oxir; `;param` faqat yo'l segmentidan keyin.
  if (segments.length === 0) return `${hostRe}([/?#]|$)`;
  return `${hostRe}/+${segments.map(escapeRe).join('/+')}([/?#;]|$)`;
}

// userinfo (`user@`) ixtiyoriy: `https://x@bad.com` ham bloklanadi; `;param` yo'l oxiri sifatida (canonicalPath).
function groups(patterns: UrlPattern[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < patterns.length; i += size) {
    const chunk = patterns.slice(i, i + size).map(fragment);
    out.push(`^https?://([^/?#@]*@)?(${chunk.join('|')})`);
  }
  return out;
}

// Effective web siyosatidan dinamik qoidalar (to'liq almashtiriladi). Faqat navigatsiya (main_frame → bloklangan
// sahifa, sub_frame → blok): resurslar (CDN, rasm) sahifa ishlashi uchun tegilmaydi.
export function toDnrRules(web: EffectiveWeb, groupSize = MAX_PATTERNS_PER_REGEX): DnrRule[] {
  const rules: DnrRule[] = [];
  let id = 1;
  const add = (priority: number, type: 'block' | 'allow', condition: DnrRule['condition']) => {
    if (type === 'allow') {
      rules.push({
        id: id++,
        priority,
        action: { type: 'allow' },
        condition: { ...condition, resourceTypes: ['main_frame', 'sub_frame'] },
      });
      return;
    }
    rules.push({
      id: id++,
      priority,
      action: { type: 'redirect', redirect: { extensionPath: BLOCKED_PAGE } },
      condition: { ...condition, resourceTypes: ['main_frame'] },
    });
    rules.push({
      id: id++,
      priority,
      action: { type: 'block' },
      condition: { ...condition, resourceTypes: ['sub_frame'] },
    });
  };
  for (const regexFilter of groups(web.block, groupSize)) {
    add(PRIORITY_BLOCK, 'block', { regexFilter, isUrlFilterCaseSensitive: false });
  }
  if (web.allowOnly !== null) {
    for (const regexFilter of groups(web.allowOnly, groupSize)) {
      add(PRIORITY_ALLOW, 'allow', { regexFilter, isUrlFilterCaseSensitive: false });
    }
    add(PRIORITY_CATCH_ALL, 'block', { urlFilter: '|http' });
  }
  return rules;
}

// Navigatsiya uchun qo'shimcha tekshiruv (background): domain'ning kanonik mosligi bilan — DNR regex'i
// %-kodlangan yo'llarni ko'rmasligi mumkin. Faqat http(s).
export function isBlocked(web: EffectiveWeb, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (web.block.some((p) => matchesUrl(p, url))) return true;
  return web.allowOnly !== null && !web.allowOnly.some((p) => matchesUrl(p, url));
}
