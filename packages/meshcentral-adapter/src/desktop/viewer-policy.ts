import type { RemoteMode } from '@netschool/domain';
import type { CredentialHandles } from './credential-handles.ts';

export type RouteVerdict = { ok: true; upstreamPath: string } | { ok: false; reason: string };
export type FrameVerdict = { ok: true; data: string | Buffer } | { ok: false; reason: string };

export interface ViewerContext {
  nodeId: string;
  mode: RemoteMode;
  handles: CredentialHandles;
}

const deny = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const STATIC_PREFIXES = ['/scripts/', '/styles/', '/images/', '/sounds/'];
const STATIC_FILES = new Set(['/favicon.ico', '/manifest.json', '/logo.png']);
const STATIC_PATH = /^\/(?:scripts|styles|images|sounds)\/[A-Za-z0-9._~@-]+(?:\/[A-Za-z0-9._~@-]+)*$/;
const CACHE_BUSTER = /^\?[0-9a-fA-F]{1,64}$/;
const HIDE = /^\d{1,4}$/;
const TUNNEL_ID = /^[0-9a-z]{1,16}$/;
const TUNNEL_PREFIX = '*/meshrelay.ashx?';
const MAX_RESPONSE_ID = 128;

export function viewerEntryPath(nodeId: string): string {
  return `/?gotonode=${encodeURIComponent(nodeId)}&viewmode=11&hide=31`;
}

// Yo'lda ".." , "//", "\" yoki kodlangan nuqta/slash/backslash bo'lsa rad.
function hasUnsafePath(pathname: string): boolean {
  return /(?:\.\.|\/\/|\\|%2e|%2f|%5c)/i.test(pathname);
}

// Kalitlar aynan `keys` to'plami va har biri bir marta bo'lishi shart.
function hasExactKeys(params: URLSearchParams, keys: readonly string[]): boolean {
  const seen = [...params.keys()];
  if (seen.length !== keys.length) return false;
  return keys.every((key) => params.getAll(key).length === 1);
}

export function routeViewerHttp(method: string, url: URL, ctx: ViewerContext): RouteVerdict {
  if (method !== 'GET' && method !== 'HEAD') return deny('method');
  const { pathname, search } = url;
  if (hasUnsafePath(pathname)) return deny('path');

  if (pathname === '/') {
    if (!hasExactKeys(url.searchParams, ['gotonode', 'viewmode', 'hide'])) return deny('entry_query');
    const hide = url.searchParams.get('hide') ?? '';
    if (url.searchParams.get('gotonode') !== ctx.nodeId) return deny('entry_node');
    if (url.searchParams.get('viewmode') !== '11') return deny('entry_viewmode');
    if (!HIDE.test(hide)) return deny('entry_hide');
    return { ok: true, upstreamPath: `/?gotonode=${encodeURIComponent(ctx.nodeId)}&viewmode=11&hide=${hide}` };
  }

  const isStatic =
    STATIC_FILES.has(pathname) || (STATIC_PREFIXES.some((p) => pathname.startsWith(p)) && STATIC_PATH.test(pathname));
  if (!isStatic) return deny('route');
  if (search !== '' && !CACHE_BUSTER.test(search)) return deny('static_query');
  return { ok: true, upstreamPath: `${pathname}${search}` };
}

export function routeViewerWs(url: URL, ctx: ViewerContext): RouteVerdict {
  const { pathname, search, searchParams } = url;
  if (hasUnsafePath(pathname)) return deny('path');

  if (pathname === '/control.ashx') {
    return search === '' ? { ok: true, upstreamPath: '/control.ashx' } : deny('control_query');
  }
  if (pathname !== '/meshrelay.ashx') return deny('route');

  if (!hasExactKeys(searchParams, ['browser', 'p', 'nodeid', 'id', 'auth'])) return deny('relay_query');
  if (searchParams.get('browser') !== '1') return deny('relay_browser');
  if (searchParams.get('p') !== '2') return deny('relay_protocol');
  if (searchParams.get('nodeid') !== ctx.nodeId) return deny('relay_node');
  const id = searchParams.get('id') ?? '';
  if (!TUNNEL_ID.test(id)) return deny('relay_id');
  const real = ctx.handles.resolve('auth', searchParams.get('auth') ?? '');
  if (real === undefined) return deny('relay_auth');
  const query = `browser=1&p=2&nodeid=${encodeURIComponent(ctx.nodeId)}&id=${id}&auth=${encodeURIComponent(real)}`;
  return { ok: true, upstreamPath: `/meshrelay.ashx?${query}` };
}

type Frame = Record<string, unknown>;

function parseObject(text: string): Frame | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Frame;
  } catch {
    return undefined;
  }
}

// Kalitlar `required` + ixtiyoriy `optional` dan iborat bo'lishi shart.
function keysMatch(frame: Frame, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(frame);
  if (!required.every((key) => Object.hasOwn(frame, key))) return false;
  return keys.every((key) => required.includes(key) || optional.includes(key));
}

const PLAIN_ACTIONS = new Set(['ping', 'pong', 'authcookie', 'usergroups', 'meshes', 'nodes', 'loginTokens', 'files']);
const NODE_ACTIONS = new Set(['powertimeline', 'lastconnect', 'getsysinfo', 'getnetworkinfo', 'deviceShares']);

function validResponseId(frame: Frame): boolean {
  if (!Object.hasOwn(frame, 'responseid')) return true;
  const id = frame.responseid;
  return typeof id === 'string' && id.length <= MAX_RESPONSE_ID;
}

export function filterControlUp(text: string, ctx: ViewerContext): FrameVerdict {
  const frame = parseObject(text);
  if (!frame) return deny('not_object');
  const action = frame.action;
  if (typeof action !== 'string') return deny('action:');

  if (action === 'msg') return filterMsg(frame, ctx);

  const reason = deny(`action:${action}`);
  if (PLAIN_ACTIONS.has(action)) {
    return keysMatch(frame, ['action'], ['responseid']) && validResponseId(frame) ? { ok: true, data: text } : reason;
  }
  if (NODE_ACTIONS.has(action)) {
    const ok = keysMatch(frame, ['action', 'nodeid'], ['responseid']) && validResponseId(frame);
    return ok && frame.nodeid === ctx.nodeId ? { ok: true, data: text } : reason;
  }
  if (action === 'getNotes') {
    const ok = keysMatch(frame, ['action', 'id'], ['responseid']) && validResponseId(frame);
    return ok && frame.id === ctx.nodeId ? { ok: true, data: text } : reason;
  }
  return reason;
}

// Faqat TCP/UDP'siz, node'ga bog'langan relay tunnel; rauth handle real qiymatga almashtiriladi.
function filterMsg(frame: Frame, ctx: ViewerContext): FrameVerdict {
  const type = frame.type;
  if (type !== 'tunnel') return deny(`msg:${typeof type === 'string' ? type : ''}`);
  const reason = deny('msg:tunnel');
  if (!keysMatch(frame, ['action', 'type', 'nodeid', 'value', 'usage'])) return reason;
  if (frame.nodeid !== ctx.nodeId || frame.usage !== 2) return reason;

  const value = frame.value;
  if (typeof value !== 'string' || !value.startsWith(TUNNEL_PREFIX)) return reason;
  const query = value.slice(TUNNEL_PREFIX.length);
  const segments = query.split('&');
  const params = new URLSearchParams(query);
  if (segments.length !== 4 || !hasExactKeys(params, ['p', 'nodeid', 'id', 'rauth'])) return reason;
  if (params.get('p') !== '2' || params.get('nodeid') !== ctx.nodeId) return reason;
  if (!TUNNEL_ID.test(params.get('id') ?? '')) return reason;
  const real = ctx.handles.resolve('relay', params.get('rauth') ?? '');
  if (real === undefined) return reason;

  // Tartib va format saqlanadi, faqat rauth qiymati almashadi.
  const rewritten = segments
    .map((segment) => (new URLSearchParams(segment).has('rauth') ? `rauth=${real}` : segment))
    .join('&');
  return { ok: true, data: JSON.stringify({ ...frame, value: `${TUNNEL_PREFIX}${rewritten}` }) };
}

export function filterControlDown(text: string, ctx: ViewerContext): FrameVerdict {
  const frame = parseObject(text);
  let out = text;
  if (frame?.action === 'authcookie') {
    for (const [field, kind] of [
      ['cookie', 'auth'],
      ['rcookie', 'relay'],
    ] as const) {
      const real = frame[field];
      if (real === undefined) continue;
      if (typeof real !== 'string' || real === '') return deny('invalid_authcookie');
      frame[field] = ctx.handles.remember(kind, real);
    }
    out = JSON.stringify(frame);
  }
  // JSON escape (R...) orqali yashirilgan qiymatni ham ushlash uchun normalizatsiya qilingan matn ham tekshiriladi.
  const normalized = frame ? JSON.stringify(frame) : out;
  for (const real of ctx.handles.reals()) {
    if (real !== '' && (out.includes(real) || normalized.includes(real))) return deny('credential_leak');
  }
  return { ok: true, data: out };
}
