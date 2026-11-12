// Web siyosati uchun URL pattern: `host` yoki `*.host`, ixtiyoriy `/yo'l-prefiksi`. Regex yo'q (spec: siyosatda
// erkin ifoda bo'lmaydi). Normallashgan ko'rinish hub, Companion va extension'da bir xil taqqoslanadi.
export type UrlPattern = string;

export const MAX_PATTERN_LENGTH = 300;

const SCHEME = /^https?:\/\//i;
const ASCII_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
// `%` va `;` yo'q: brauzer URL'i bilan solishtirish kanonik yo'l ustida (canonicalPath).
const PATH = /^\/[A-Za-z0-9\-._~/]*$/;

function asciiHost(raw: string): string | null {
  if (raw === '' || /[^\p{L}\p{N}.-]/u.test(raw)) return null;
  let host: string;
  try {
    host = new URL(`http://${raw}`).hostname;
  } catch {
    return null;
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  return ASCII_HOST.test(host) ? host : null;
}

// Normallashtiradi yoki noto'g'ri bo'lsa null: kichik harfli punycode host, oxirgi nuqta, `http(s)://` va port
// olib tashlanadi; yo'l kichik harfga (yo'l bo'yicha bloklash registr bilan chetlab o'tilmasin), yolg'iz `/` tashlanadi.
export function normalizePattern(input: string): UrlPattern | null {
  let rest = input.trim();
  if (rest.length === 0 || rest.length > MAX_PATTERN_LENGTH) return null;
  rest = rest.replace(SCHEME, '');
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(rest)) return null; // boshqa sxema (javascript:, ftp: ...)
  // `javascript:1`, `data:1` port kabi ko'rinadi: ma'lum sxema nomlari host sifatida qabul qilinmaydi.
  if (/^(javascript|data|file|about|blob|vbscript|ftp|ws|wss|mailto|chrome|edge|view-source)(:|$)/i.test(rest))
    return null;
  const slash = rest.indexOf('/');
  let hostPart = slash < 0 ? rest : rest.slice(0, slash);
  let path = slash < 0 ? '' : rest.slice(slash);
  const port = hostPart.match(/:(\d{1,5})$/);
  if (port) {
    if (Number(port[1]) > 65535) return null;
    hostPart = hostPart.slice(0, -port[0].length);
  }
  let wildcard = false;
  if (hostPart.startsWith('*.')) {
    wildcard = true;
    hostPart = hostPart.slice(2);
  }
  const host = asciiHost(hostPart);
  if (!host) return null;
  if (path !== '' && !PATH.test(path)) return null;
  // `.`/`..` segmentlari rad etiladi: pattern yozilgandek ma'noda bo'lsin, hal qilinib boshqa yo'lga aylanmasin.
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  path = canonicalPath(path);
  if (path === '/') path = '';
  const out = `${wildcard ? '*.' : ''}${host}${path}`;
  return out.length > MAX_PATTERN_LENGTH ? null : out;
}

// Kanonik yo'l (keng shakl): %-kodlash to'liq ochiladi (`%2f` ham `/` bo'ladi), `;param` tashlanadi, `//` birlashadi,
// `.`/`..` hal qilinadi, kichik harf. Blokni kengaytiradi: `/%64ocs`, `//docs`, `/DOCS`, `/admin%2fx` blokdan o'tmaydi.
// Allowlist uchun yolg'iz o'zi ishlatilmaydi (matchesUrl): `/secret%2f..%2fdocs` bu shaklda `/docs` bo'lib qoladi.
export function canonicalPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // noto'g'ri %-ketma-ketlik — xom holicha
  }
  const out: string[] = [];
  for (const raw of decoded.toLowerCase().split('/')) {
    const seg = raw.split(';')[0] ?? '';
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  const trailing = decoded.endsWith('/') && out.length > 0 ? '/' : '';
  return `/${out.join('/')}${trailing}`;
}

// Qat'iy shakl: faqat unreserved belgilar (`A-Za-z0-9-._~`) ochiladi — `%2f`, `%3b`, `%5c` kodlangan qoladi va yo'lni
// bo'lmaydi; brauzer pathname'i allaqachon dot-normallashgan. Literal `;param` va bo'sh segmentlar tashlanadi.
// `..` qolsa (bo'lmasligi kerak) null — allowlist mos kelmaydi.
function strictPath(path: string): string | null {
  const unreserved = path.replace(/%([0-9a-f]{2})/gi, (m, hex: string) => {
    const ch = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : m;
  });
  const out: string[] = [];
  for (const raw of unreserved.toLowerCase().split('/')) {
    const seg = raw.split(';')[0] ?? '';
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  const trailing = unreserved.endsWith('/') && out.length > 0 ? '/' : '';
  return `/${out.join('/')}${trailing}`;
}

function split(pattern: UrlPattern): { wildcard: boolean; host: string; path: string } {
  const wildcard = pattern.startsWith('*.');
  const body = wildcard ? pattern.slice(2) : pattern;
  const slash = body.indexOf('/');
  return {
    wildcard,
    host: slash < 0 ? body : body.slice(0, slash),
    path: slash < 0 ? '' : body.slice(slash),
  };
}

// Pattern URL'ga mosmi: host teng (yoki `*.` uchun subdomen), yo'l prefiksi segment chegarasida.
// Xavfsiz tomonga yopiq: `block` — keng yoki qat'iy shakldan biri mos kelsa; `allow` — ikkalasi ham mos kelsa.
export function matchesUrl(pattern: UrlPattern, url: URL, purpose: 'block' | 'allow'): boolean {
  const p = split(pattern);
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  const hostOk = host === p.host || (p.wildcard && host.endsWith(`.${p.host}`));
  if (!hostOk) return false;
  if (p.path === '') return true;
  const prefix = p.path.endsWith('/') ? p.path : `${p.path}/`;
  const under = (path: string | null) => path !== null && (path === p.path || path.startsWith(prefix));
  const loose = under(canonicalPath(url.pathname));
  const strict = under(strictPath(url.pathname));
  return purpose === 'block' ? loose || strict : loose && strict;
}
