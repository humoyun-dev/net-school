import type { IncomingHttpHeaders } from 'node:http';

// Hop-by-hop headerlar (RFC 9110 7.6.1) proksi orqali o'tmaydi.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Brauzer bergan kredensial va yo'naltirish headerlari upstream'ga hech qachon o'tmaydi.
const BLOCKED = new Set([
  'host',
  'cookie',
  'authorization',
  'x-meshauth',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
]);

const connectionTokens = (h: IncomingHttpHeaders): Set<string> => {
  const raw = h.connection;
  const value = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  return new Set(
    value
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
};

const joinValue = (value: string | string[]): string => (Array.isArray(value) ? value.join(', ') : value);

// Upstream'ga ketadigan so'rov headerlari: qora ro'yxatdagilar va hop-by-hop olib tashlanadi.
export function sanitizeRequestHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const named = connectionTokens(h);
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(h)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (BLOCKED.has(name) || HOP_BY_HOP.has(name) || named.has(name) || name.startsWith('x-forwarded-')) continue;
    out[name] = joinValue(value);
  }
  return out;
}

// Brauzerga qaytadigan javob headerlari: set-cookie (upstream cookie'si) va hop-by-hop olib tashlanadi.
export function sanitizeResponseHeaders(h: IncomingHttpHeaders): Record<string, string | string[]> {
  const named = connectionTokens(h);
  const out: Record<string, string | string[]> = {};
  for (const [rawName, value] of Object.entries(h)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (name === 'set-cookie' || HOP_BY_HOP.has(name) || named.has(name)) continue;
    out[name] = value;
  }
  return out;
}
