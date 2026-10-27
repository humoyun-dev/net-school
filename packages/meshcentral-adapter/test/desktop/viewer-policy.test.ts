import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CredentialHandles } from '../../src/desktop/credential-handles.ts';
import {
  filterControlDown,
  filterControlUp,
  filterRelayUp,
  rewriteViewerHtml,
  routeViewerHttp,
  routeViewerWs,
  VIEW_ONLY_INPUT_COMMANDS,
  type ViewerContext,
  viewerEntryPath,
} from '../../src/desktop/viewer-policy.ts';
import { AdapterError } from '../../src/errors.ts';

const NODE = 'node//abc';
const OTHER = 'node//xyz';
const BASE = 'https://gw.example';

function makeCtx(mode: 'view' | 'control' = 'view'): ViewerContext {
  return { nodeId: NODE, mode, handles: new CredentialHandles() };
}
const u = (path: string) => new URL(path, BASE);

function tunnelFrame(value: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ action: 'msg', type: 'tunnel', nodeid: NODE, value, usage: 2, ...extra });
}

describe('routeViewerHttp', () => {
  test('routeViewerHttp allows the entry page for the session node only', () => {
    const ctx = makeCtx();
    const ok = routeViewerHttp('GET', u(viewerEntryPath(NODE)), ctx);
    expect(ok).toEqual({ ok: true, upstreamPath: viewerEntryPath(NODE) });
    expect(routeViewerHttp('HEAD', u(viewerEntryPath(NODE)), ctx).ok).toBe(true);
    expect(routeViewerHttp('GET', u(viewerEntryPath(OTHER)), ctx).ok).toBe(false);
    expect(routeViewerHttp('GET', u(`${viewerEntryPath(NODE)}&key=1`), ctx).ok).toBe(false);
    expect(routeViewerHttp('POST', u(viewerEntryPath(NODE)), ctx).ok).toBe(false);
    expect(routeViewerHttp('GET', u('/'), ctx).ok).toBe(false);
  });

  test('entry page rejects wrong viewmode, bad hide, duplicates, missing keys', () => {
    const ctx = makeCtx();
    const g = encodeURIComponent(NODE);
    expect(routeViewerHttp('GET', u(`/?gotonode=${g}&viewmode=1&hide=31`), ctx).ok).toBe(false);
    expect(routeViewerHttp('GET', u(`/?gotonode=${g}&viewmode=11&hide=abc`), ctx).ok).toBe(false);
    expect(routeViewerHttp('GET', u(`/?gotonode=${g}&viewmode=11&hide=12345`), ctx).ok).toBe(false);
    expect(routeViewerHttp('GET', u(`/?gotonode=${g}&viewmode=11`), ctx).ok).toBe(false);
    expect(routeViewerHttp('GET', u(`/?gotonode=${g}&gotonode=${g}&viewmode=11&hide=31`), ctx).ok).toBe(false);
    expect(routeViewerHttp('GET', u(`/?gotonode=${g}&viewmode=11&viewmode=11&hide=31`), ctx).ok).toBe(false);
  });

  test('routeViewerHttp allows static prefixes and rejects traversal', () => {
    const ctx = makeCtx();
    expect(routeViewerHttp('GET', u('/scripts/x.js'), ctx)).toEqual({ ok: true, upstreamPath: '/scripts/x.js' });
    expect(routeViewerHttp('GET', u('/styles/a.css?1a2b'), ctx)).toEqual({
      ok: true,
      upstreamPath: '/styles/a.css?1a2b',
    });
    expect(routeViewerHttp('GET', u('/images/a.png'), ctx).ok).toBe(true);
    expect(routeViewerHttp('GET', u('/sounds/a.mp3'), ctx).ok).toBe(true);
    for (const p of ['/favicon.ico', '/manifest.json', '/logo.png']) {
      expect(routeViewerHttp('GET', u(p), ctx).ok).toBe(true);
    }
    const bad = [
      '/scripts/../meshcentral.db',
      '/scripts/%2e%2e/x',
      '/scripts/%2E%2e/x',
      '/scripts/..%2fx',
      '/scripts/a%5Cb',
      '/scripts/a%5cb',
      '/scripts/a%2Fb',
      '//x',
      '/scripts//x',
      '/devicefile.ashx',
      '/logout',
      '/webrelay/',
      '/scripts/',
      '/scripts',
      '/scriptsx/a.js',
      '/favicon.ico/x',
      '/scripts/a.js?foo=bar',
      '/scripts/a.js?x',
      '/favicon.ico?zz',
      '/scripts/a%00.js',
      '/scripts/a%20b.js',
    ];
    for (const p of bad) {
      const verdict = routeViewerHttp('GET', u(p), ctx);
      expect(verdict.ok, p).toBe(false);
    }
  });

  test('rejects unsafe pathnames even when the URL parser did not normalize them', () => {
    // URL parser "\\" va ".." ni o'zi normallashtiradi; pathname bevosita berilganda ham rad etiladi.
    const ctx = makeCtx();
    for (const pathname of ['/scripts/../meshcentral.db', '/scripts/a\\b', '/scripts/%2e%2e/x', '//x']) {
      const url = new URL(`${BASE}/scripts/x.js`);
      Object.defineProperty(url, 'pathname', { value: pathname });
      expect(routeViewerHttp('GET', url, ctx).ok, pathname).toBe(false);
    }
  });

  test('rejects non GET/HEAD methods', () => {
    const ctx = makeCtx();
    for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'get', 'CONNECT', '']) {
      expect(routeViewerHttp(m, u('/scripts/x.js'), ctx).ok, m).toBe(false);
    }
  });
});

describe('routeViewerWs', () => {
  function wsUrl(over: Record<string, string> = {}, drop: string[] = []): { url: URL; ctx: ViewerContext } {
    const ctx = makeCtx();
    const auth = ctx.handles.remember('auth', 'REALAUTH');
    const params: Record<string, string> = { browser: '1', p: '2', nodeid: NODE, id: 'abc123', auth, ...over };
    for (const k of drop) delete params[k];
    return { url: u(`/meshrelay.ashx?${new URLSearchParams(params).toString()}`), ctx };
  }

  test('routeViewerWs allows control.ashx without query only', () => {
    const ctx = makeCtx();
    expect(routeViewerWs(u('/control.ashx'), ctx)).toEqual({ ok: true, upstreamPath: '/control.ashx' });
    expect(routeViewerWs(u('/control.ashx?auth=x'), ctx).ok).toBe(false);
    expect(routeViewerWs(u('/control.ashx/'), ctx).ok).toBe(false);
    expect(routeViewerWs(u('/other.ashx'), ctx).ok).toBe(false);
    expect(routeViewerWs(u('//control.ashx'), ctx).ok).toBe(false);
  });

  test('routeViewerWs maps auth handle to the real cookie', () => {
    const { url, ctx } = wsUrl();
    const verdict = routeViewerWs(url, ctx);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.upstreamPath).toContain('auth=REALAUTH');
    expect(verdict.upstreamPath).not.toContain('nsh_');
    expect(verdict.upstreamPath.startsWith('/meshrelay.ashx?')).toBe(true);
    const q = new URL(verdict.upstreamPath, BASE).searchParams;
    expect(q.get('nodeid')).toBe(NODE);
    expect(q.get('browser')).toBe('1');
    expect(q.get('p')).toBe('2');
    expect(q.get('id')).toBe('abc123');
  });

  test('routeViewerWs encodes a real cookie that has special characters', () => {
    const ctx = makeCtx();
    const auth = ctx.handles.remember('auth', 'a&b=c d');
    const url = u(`/meshrelay.ashx?browser=1&p=2&nodeid=${encodeURIComponent(NODE)}&id=x1&auth=${auth}`);
    const verdict = routeViewerWs(url, ctx);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const q = new URL(verdict.upstreamPath, BASE).searchParams;
    expect([...q.keys()]).toEqual(['browser', 'p', 'nodeid', 'id', 'auth']);
    expect(q.get('auth')).toBe('a&b=c d');
  });

  test('routeViewerWs rejects foreign node, tcpport, unknown handle', () => {
    expect(routeViewerWs(...args(wsUrl({ nodeid: OTHER }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({ tcpport: '22' }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({ udpport: '53' }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({ auth: 'nsh_unknown' }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({ auth: 'REALAUTH' }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({ p: '1' }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({ browser: '0' }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({ id: 'ABC' }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({ id: 'a'.repeat(17) }))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({}, ['auth']))).ok).toBe(false);
    expect(routeViewerWs(...args(wsUrl({}, ['id']))).ok).toBe(false);
  });

  test('routeViewerWs rejects a relay handle used as auth', () => {
    const ctx = makeCtx();
    const relay = ctx.handles.remember('relay', 'REALRELAY');
    const url = u(`/meshrelay.ashx?browser=1&p=2&nodeid=${encodeURIComponent(NODE)}&id=x1&auth=${relay}`);
    expect(routeViewerWs(url, ctx).ok).toBe(false);
  });

  test('routeViewerWs rejects duplicated parameters', () => {
    const { url, ctx } = wsUrl();
    const dupP = new URL(`${url.href}&p=1`);
    expect(routeViewerWs(dupP, ctx).ok).toBe(false);
    const dupNode = new URL(`${url.href}&nodeid=${encodeURIComponent(OTHER)}`);
    expect(routeViewerWs(dupNode, ctx).ok).toBe(false);
    const p21 = u(url.pathname + url.search.replace('p=2', 'p=2&p=1'));
    expect(routeViewerWs(p21, ctx).ok).toBe(false);
  });
});

function args(w: { url: URL; ctx: ViewerContext }): [URL, ViewerContext] {
  return [w.url, w.ctx];
}

describe('filterControlUp', () => {
  test('filterControlUp allows the viewer startup actions', () => {
    const ctx = makeCtx();
    const frames = [
      { action: 'ping' },
      { action: 'pong' },
      { action: 'authcookie' },
      { action: 'usergroups' },
      { action: 'meshes' },
      { action: 'nodes' },
      { action: 'loginTokens' },
      { action: 'files' },
      { action: 'nodes', responseid: 'r1' },
      { action: 'powertimeline', nodeid: NODE },
      { action: 'lastconnect', nodeid: NODE },
      { action: 'getsysinfo', nodeid: NODE, responseid: 'x' },
      { action: 'getnetworkinfo', nodeid: NODE },
      { action: 'deviceShares', nodeid: NODE },
      { action: 'getNotes', id: NODE },
    ];
    for (const f of frames) {
      const text = JSON.stringify(f);
      expect(filterControlUp(text, ctx), text).toEqual({ ok: true, data: text });
    }
  });

  test('filterControlUp allows the real viewer nodes request', () => {
    const ctx = makeCtx();
    const frames = [
      { action: 'nodes', id: '', skip: 0, filter: '' },
      { action: 'nodes', id: NODE, skip: 0, filter: 'pc' },
      { action: 'nodes', skip: 5 },
      { action: 'nodes', skip: 0, responseid: 'r' },
    ];
    for (const f of frames) {
      const text = JSON.stringify(f);
      expect(filterControlUp(text, ctx), text).toEqual({ ok: true, data: text });
    }
  });

  test('filterControlUp rejects nodes with a foreign id, bad skip or oversized filter', () => {
    const ctx = makeCtx();
    const frames: Record<string, unknown>[] = [
      { action: 'nodes', id: OTHER, skip: 0 },
      { action: 'nodes', id: 5 },
      { action: 'nodes', skip: -1 },
      { action: 'nodes', skip: 1.5 },
      { action: 'nodes', skip: '0' },
      { action: 'nodes', filter: 'a'.repeat(257) },
      { action: 'nodes', filter: 5 },
      { action: 'nodes', skip: 0, meshid: 'mesh//x' },
    ];
    for (const f of frames) {
      const text = JSON.stringify(f);
      expect(filterControlUp(text, ctx), text).toEqual({ ok: false, reason: 'action:nodes' });
    }
    const maxFilter = JSON.stringify({ action: 'nodes', filter: 'a'.repeat(256) });
    expect(filterControlUp(maxFilter, ctx).ok).toBe(true);
  });

  test('filterControlUp rejects every non-tunnel msg', () => {
    const ctx = makeCtx('control');
    for (const type of ['pskill', 'serviceStop', 'openUrl', 'setclip', 'getclip', 'console', 'localapp']) {
      const v = filterControlUp(JSON.stringify({ action: 'msg', type, nodeid: NODE, value: 'x', usage: 2 }), ctx);
      expect(v, type).toEqual({ ok: false, reason: `msg:${type}` });
    }
    expect(filterControlUp(JSON.stringify({ action: 'msg', nodeid: NODE }), ctx).ok).toBe(false);
  });

  test('filterControlUp rejects actions outside the allowlist', () => {
    const ctx = makeCtx();
    const rejected: Record<string, unknown>[] = [
      { action: 'getcookie' },
      { action: 'createLoginToken', name: 'x' },
      { action: 'adduser', username: 'a' },
      { action: 'removedevices', nodeids: [NODE] },
      { action: 'getsysinfo', nodeid: OTHER },
      { action: 'nodes', meshid: 'mesh//x' },
      { action: 'powertimeline' },
      { action: 'getNotes', id: OTHER },
      { action: 'getNotes', nodeid: NODE },
      { action: 'ping', extra: 1 },
      { action: 'ping', nodeid: NODE },
      { action: 'powertimeline', nodeid: NODE, extra: 1 },
      { action: 'nodes', responseid: 5 },
      { action: 1 },
      {},
    ];
    for (const f of rejected) {
      const text = JSON.stringify(f);
      expect(filterControlUp(text, ctx).ok, text).toBe(false);
    }
    expect(filterControlUp(JSON.stringify({ action: 'getcookie' }), ctx)).toEqual({
      ok: false,
      reason: 'action:getcookie',
    });
  });

  test('filterControlUp rejects non-object and malformed JSON', () => {
    const ctx = makeCtx();
    for (const t of ['', 'nope', '[]', 'null', '"ping"', '1', '[{"action":"ping"}]', '{"action":"ping"']) {
      expect(filterControlUp(t, ctx).ok, t).toBe(false);
    }
  });

  test('filterControlUp judges duplicated JSON keys the way the upstream parser reads them', () => {
    const ctx = makeCtx();
    expect(filterControlUp('{"action":"ping","action":"pskill"}', ctx).ok).toBe(false);
    expect(filterControlUp('{"action":"pskill","action":"ping"}', ctx).ok).toBe(true);
  });

  test('filterControlUp rejects prototype tricks', () => {
    const ctx = makeCtx();
    expect(filterControlUp('{"action":"ping","__proto__":{"x":1}}', ctx).ok).toBe(false);
    expect(filterControlUp('{"action":"constructor"}', ctx).ok).toBe(false);
    expect(filterControlUp('{"action":"toString"}', ctx).ok).toBe(false);
  });

  test('filterControlUp rewrites rauth in a valid tunnel request', () => {
    const ctx = makeCtx();
    const handle = ctx.handles.remember('relay', 'REALRELAY');
    const value = `*/meshrelay.ashx?p=2&nodeid=${NODE}&id=abc123&rauth=${handle}`;
    const verdict = filterControlUp(tunnelFrame(value), ctx);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const text = String(verdict.data);
    expect(text).toContain('REALRELAY');
    expect(text).not.toContain('nsh_');
    expect(text).toBe(tunnelFrame(`*/meshrelay.ashx?p=2&nodeid=${NODE}&id=abc123&rauth=REALRELAY`));
    expect(Object.keys(JSON.parse(text))).toEqual(['action', 'type', 'nodeid', 'value', 'usage']);
  });

  test('filterControlUp accepts an encoded nodeid inside the tunnel value', () => {
    const ctx = makeCtx();
    const handle = ctx.handles.remember('relay', 'REALRELAY');
    const value = `*/meshrelay.ashx?p=2&nodeid=${encodeURIComponent(NODE)}&id=abc123&rauth=${handle}`;
    const verdict = filterControlUp(tunnelFrame(value), ctx);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(String(verdict.data)).toContain('rauth=REALRELAY');
  });

  test('filterControlUp rejects tunnel with unknown, auth-kind or missing rauth', () => {
    const ctx = makeCtx();
    const authHandle = ctx.handles.remember('auth', 'REALAUTH');
    const mk = (r?: string) =>
      tunnelFrame(`*/meshrelay.ashx?p=2&nodeid=${NODE}&id=abc123${r === undefined ? '' : `&rauth=${r}`}`);
    expect(filterControlUp(mk('nsh_unknown'), ctx).ok).toBe(false);
    expect(filterControlUp(mk('REALRELAY'), ctx).ok).toBe(false);
    expect(filterControlUp(mk(authHandle), ctx).ok).toBe(false);
    expect(filterControlUp(mk(), ctx).ok).toBe(false);
  });

  describe('tunnel value hardening', () => {
    function ctxWithRelay(): { ctx: ViewerContext; handle: string } {
      const ctx = makeCtx();
      return { ctx, handle: ctx.handles.remember('relay', 'REALRELAY') };
    }
    const q = (h: string, extra = '') => `p=2&nodeid=${NODE}&id=abc123&rauth=${h}${extra}`;

    test('filterControlUp rejects tunnel value with duplicated parameters', () => {
      const { ctx, handle } = ctxWithRelay();
      expect(filterControlUp(tunnelFrame(`*/meshrelay.ashx?${q(handle, '&p=1')}`), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(`*/meshrelay.ashx?${q(handle, '&p=2')}`), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(`*/meshrelay.ashx?${q(handle, `&nodeid=${OTHER}`)}`), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(`*/meshrelay.ashx?${q(handle, `&rauth=${handle}`)}`), ctx).ok).toBe(false);
    });

    test('filterControlUp rejects tunnel value with tcpport', () => {
      const { ctx, handle } = ctxWithRelay();
      expect(filterControlUp(tunnelFrame(`*/meshrelay.ashx?${q(handle, '&tcpport=22')}`), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(`*/meshrelay.ashx?${q(handle, '&udpport=53')}`), ctx).ok).toBe(false);
    });

    test('filterControlUp rejects tunnel value with p=1', () => {
      const { ctx, handle } = ctxWithRelay();
      const v = `*/meshrelay.ashx?p=1&nodeid=${NODE}&id=abc123&rauth=${handle}`;
      expect(filterControlUp(tunnelFrame(v), ctx).ok).toBe(false);
    });

    test('filterControlUp rejects tunnel value with foreign nodeid', () => {
      const { ctx, handle } = ctxWithRelay();
      const v = `*/meshrelay.ashx?p=2&nodeid=${OTHER}&id=abc123&rauth=${handle}`;
      expect(filterControlUp(tunnelFrame(v), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(q(handle), { nodeid: OTHER }), ctx).ok).toBe(false);
    });

    test('filterControlUp rejects malformed tunnel value shapes', () => {
      const { ctx, handle } = ctxWithRelay();
      const bad = [
        `*/meshrelay.ashx?${q(handle)}&`,
        `*/meshrelay.ashx?&${q(handle)}`,
        `*/meshrelay.ashx?${q(handle)}#x`,
        `*/meshrelay.ashx?p=2&nodeid=${NODE}&id=ABC&rauth=${handle}`,
        `*/meshrelay.ashx?p=2&nodeid=${NODE}&id=&rauth=${handle}`,
        `*/meshrelay.ashx?p=2&nodeid=${NODE}&id=${'a'.repeat(17)}&rauth=${handle}`,
        `*/meshrelay.ashx?${q(handle)}`.replace('*/', '*//'),
        `/meshrelay.ashx?${q(handle)}`,
        `*/other.ashx?${q(handle)}`,
        `*/meshrelay.ashx?`,
        `*/meshrelay.ashx`,
        `*https://evil.example/meshrelay.ashx?${q(handle)}`,
      ];
      for (const v of bad) expect(filterControlUp(tunnelFrame(v), ctx).ok, v).toBe(false);
    });

    test('filterControlUp rejects tunnel frames with wrong usage, extra keys or non-string value', () => {
      const { ctx, handle } = ctxWithRelay();
      const v = `*/meshrelay.ashx?${q(handle)}`;
      expect(filterControlUp(tunnelFrame(v, { usage: 1 }), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(v, { usage: '2' }), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(v, { usage: 11 }), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(v, { responseid: 'x' }), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(v, { extra: 1 }), ctx).ok).toBe(false);
      expect(filterControlUp(tunnelFrame(v, { value: 5 }), ctx).ok).toBe(false);
      expect(filterControlUp(JSON.stringify({ action: 'msg', type: 'tunnel', nodeid: NODE, value: v }), ctx).ok).toBe(
        false,
      );
    });
  });
});

describe('filterControlDown', () => {
  test('filterControlDown swaps refreshed cookies for handles', () => {
    const ctx = makeCtx();
    const text = JSON.stringify({ action: 'authcookie', cookie: 'REALAUTH2', rcookie: 'REALRELAY2' });
    const verdict = filterControlDown(text, ctx);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const out = JSON.parse(String(verdict.data));
    expect(out.action).toBe('authcookie');
    expect(out.cookie).toMatch(/^nsh_/);
    expect(out.rcookie).toMatch(/^nsh_/);
    expect(String(verdict.data)).not.toContain('REALAUTH2');
    expect(String(verdict.data)).not.toContain('REALRELAY2');
    expect(ctx.handles.resolve('auth', out.cookie)).toBe('REALAUTH2');
    expect(ctx.handles.resolve('relay', out.rcookie)).toBe('REALRELAY2');
  });

  test('filterControlDown keeps other authcookie fields and handles a missing rcookie', () => {
    const ctx = makeCtx();
    const verdict = filterControlDown(JSON.stringify({ action: 'authcookie', cookie: 'C1', responseid: 'z' }), ctx);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const out = JSON.parse(String(verdict.data));
    expect(out.responseid).toBe('z');
    expect(out.rcookie).toBeUndefined();
  });

  test('filterControlDown rejects an authcookie frame with a non-string or empty cookie', () => {
    const ctx = makeCtx();
    expect(filterControlDown(JSON.stringify({ action: 'authcookie', cookie: 5 }), ctx).ok).toBe(false);
    expect(filterControlDown(JSON.stringify({ action: 'authcookie', cookie: '' }), ctx).ok).toBe(false);
    expect(filterControlDown(JSON.stringify({ action: 'authcookie', rcookie: { a: 1 } }), ctx).ok).toBe(false);
  });

  test('filterControlDown passes unrelated frames unchanged', () => {
    const ctx = makeCtx();
    ctx.handles.remember('auth', 'REALAUTH');
    const text = JSON.stringify({ action: 'nodes', nodes: { m: [] } });
    expect(filterControlDown(text, ctx)).toEqual({ ok: true, data: text });
    expect(filterControlDown('not json at all', ctx)).toEqual({ ok: true, data: 'not json at all' });
  });

  test('filterControlDown drops frames carrying a real credential', () => {
    const ctx = makeCtx();
    ctx.handles.remember('auth', 'REALAUTH');
    ctx.handles.remember('relay', 'REALRELAY');
    const a = filterControlDown(JSON.stringify({ action: 'foo', x: 'has REALAUTH inside' }), ctx);
    expect(a).toEqual({ ok: false, reason: 'credential_leak' });
    const b = filterControlDown('raw text REALRELAY', ctx);
    expect(b).toEqual({ ok: false, reason: 'credential_leak' });
  });

  test('filterControlDown catches a credential hidden behind JSON unicode escapes', () => {
    const ctx = makeCtx();
    ctx.handles.remember('auth', 'REALAUTH');
    const escaped = '{"action":"foo","x":"\\u0052EALAUTH"}';
    expect(filterControlDown(escaped, ctx)).toEqual({ ok: false, reason: 'credential_leak' });
  });

  test('filterControlDown drops an authcookie frame that leaks a known credential elsewhere', () => {
    const ctx = makeCtx();
    ctx.handles.remember('relay', 'OLDRELAY');
    const text = JSON.stringify({ action: 'authcookie', cookie: 'NEW', note: 'OLDRELAY' });
    expect(filterControlDown(text, ctx)).toEqual({ ok: false, reason: 'credential_leak' });
  });
});

function relayFrame(cmd: number, size?: number, length = 8): Buffer {
  const buf = Buffer.alloc(length);
  if (length >= 2) buf.writeUInt16BE(cmd, 0);
  if (length >= 4) buf.writeUInt16BE(size ?? length, 2);
  return buf;
}

describe('filterRelayUp', () => {
  test('filterRelayUp drops every view-only input command', () => {
    expect([...VIEW_ONLY_INPUT_COMMANDS].sort((a, b) => a - b)).toEqual([1, 2, 10, 12, 85, 87]);
    for (const cmd of VIEW_ONLY_INPUT_COMMANDS) {
      const frame = relayFrame(cmd);
      expect(filterRelayUp(frame, true, 'view').ok).toBe(false);
      expect(filterRelayUp(frame, true, 'control')).toEqual({ ok: true, data: frame });
    }
  });

  test('filterRelayUp passes non-input desktop commands in view mode', () => {
    for (const cmd of [6, 5]) {
      const frame = relayFrame(cmd);
      expect(filterRelayUp(frame, true, 'view')).toEqual({ ok: true, data: frame });
    }
  });

  test('filterRelayUp drops malformed binary frames in view mode', () => {
    expect(filterRelayUp(relayFrame(6, 3, 3), true, 'view').ok).toBe(false);
    expect(filterRelayUp(Buffer.alloc(0), true, 'view').ok).toBe(false);
    expect(filterRelayUp(relayFrame(6, 9, 8), true, 'view').ok).toBe(false);
    expect(filterRelayUp(relayFrame(6, 7, 8), true, 'view').ok).toBe(false);
    expect(filterRelayUp('binary as string', true, 'view').ok).toBe(false);
  });

  test('filterRelayUp allows the protocol number and options text frames', () => {
    for (const mode of ['view', 'control'] as const) {
      expect(filterRelayUp('2', false, mode)).toEqual({ ok: true, data: '2' });
      expect(filterRelayUp(Buffer.from('2'), false, mode)).toEqual({ ok: true, data: Buffer.from('2') });
      const opts = JSON.stringify({ type: 'options', consent: 0 });
      expect(filterRelayUp(opts, false, mode)).toEqual({ ok: true, data: opts });
    }
  });

  test('filterRelayUp strips autolock from options in view mode', () => {
    const inputs = [
      { type: 'options', autolock: true, x: 1 },
      { ctrlChannel: '102938', type: 'options', autolock: true },
    ];
    for (const input of inputs) {
      const verdict = filterRelayUp(JSON.stringify(input), false, 'view');
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) continue;
      const { autolock: _removed, ...rest } = input;
      expect(JSON.parse(String(verdict.data))).toEqual(rest);
      expect(Object.hasOwn(JSON.parse(String(verdict.data)), 'autolock')).toBe(false);
    }
    const plain = JSON.stringify({ type: 'options', consent: 0 });
    expect(filterRelayUp(plain, false, 'view')).toEqual({ ok: true, data: plain });
  });

  test('filterRelayUp keeps options unchanged in control mode', () => {
    for (const input of [
      { type: 'options', autolock: true, x: 1 },
      { ctrlChannel: '102938', type: 'options', autolock: true },
    ]) {
      const text = JSON.stringify(input);
      expect(filterRelayUp(text, false, 'control')).toEqual({ ok: true, data: text });
    }
  });

  test('filterRelayUp drops other text frames', () => {
    for (const text of ['', '1', '3', '2 ', ' 2', 'c', '{', '[]', 'null', '"2"', '{"type":"unknown"}', '{"a":1}']) {
      expect(filterRelayUp(text, false, 'control').ok).toBe(false);
    }
  });

  test('filterRelayUp drops WebRTC negotiation in both modes', () => {
    const frames = [
      JSON.stringify({ type: 'offer', sdp: 'x' }),
      JSON.stringify({ type: 'answer', sdp: 'x' }),
      JSON.stringify({ ctrlChannel: '102938', type: 'webrtc0' }),
      JSON.stringify({ ctrlChannel: '102938', type: 'webrtc1' }),
      JSON.stringify({ ctrlChannel: '102938', type: 'webrtc2' }),
    ];
    for (const mode of ['view', 'control'] as const) {
      for (const f of frames) expect(filterRelayUp(f, false, mode).ok).toBe(false);
    }
  });

  test('filterRelayUp allows lock only for control', () => {
    for (const type of ['lock', 'autolock']) {
      const f = JSON.stringify({ ctrlChannel: '102938', type });
      expect(filterRelayUp(f, false, 'control')).toEqual({ ok: true, data: f });
      expect(filterRelayUp(f, false, 'view').ok).toBe(false);
    }
    const wrongChannel = JSON.stringify({ ctrlChannel: '1', type: 'lock' });
    expect(filterRelayUp(wrongChannel, false, 'control').ok).toBe(false);
    const noChannel = JSON.stringify({ type: 'lock' });
    expect(filterRelayUp(noChannel, false, 'control').ok).toBe(false);
  });
});

const PAGE = readFileSync(new URL('../fixtures/viewer-page.html', import.meta.url), 'utf8');
const PUBLIC_HOST = 'gw.example:9443';
const REAL_AUTH = 'REAL-AUTH-COOKIE@1';
const REAL_RELAY = 'REAL-RELAY-COOKIE$2';

describe('rewriteViewerHtml', () => {
  test('rewriteViewerHtml replaces credentials and public host', () => {
    const ctx = makeCtx();
    const out = rewriteViewerHtml(PAGE, ctx, PUBLIC_HOST);
    expect(out).not.toContain(REAL_AUTH);
    expect(out).not.toContain(REAL_RELAY);
    expect(out).not.toContain('mesh.internal');
    expect(out).toContain(`var serverPublicNamePort = '${PUBLIC_HOST}';`);
    const auth = /var authCookie = '([^']*)';/.exec(out)?.[1] ?? '';
    const relay = /var authRelayCookie = '([^']*)';/.exec(out)?.[1] ?? '';
    expect(ctx.handles.resolve('auth', auth)).toBe(REAL_AUTH);
    expect(ctx.handles.resolve('relay', relay)).toBe(REAL_RELAY);
    expect(out).toContain('var multiDesktop = {};');
  });

  test('rewriteViewerHtml does not interpret $ patterns in the public host', () => {
    const out = rewriteViewerHtml(PAGE, makeCtx(), 'gw.example:9443');
    expect(out).not.toContain('$');
  });

  test('rewriteViewerHtml fails closed when a credential line is missing or duplicated', () => {
    const lines = [
      "var authCookie = 'REAL-AUTH-COOKIE@1';",
      "var authRelayCookie = 'REAL-RELAY-COOKIE$2';",
      "var serverPublicNamePort = 'mesh.internal:8443';",
    ];
    const bad = (html: string) => {
      try {
        rewriteViewerHtml(html, makeCtx(), PUBLIC_HOST);
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterError);
        expect((error as AdapterError).code).toBe('invalid_upstream_message');
        return;
      }
      throw new Error('expected rewriteViewerHtml to throw');
    };
    for (const line of lines) {
      expect(PAGE).toContain(line);
      bad(PAGE.replace(line, ''));
      bad(PAGE.replace(line, `${line}\n${line.replace(/'[^']*'/, "'OTHER'")}`));
      bad(PAGE.replace(line, line.replace(/'[^']*'/, "''")));
    }
  });

  test('rewriteViewerHtml fails closed when a credential appears elsewhere in the page', () => {
    for (const real of [REAL_AUTH, REAL_RELAY]) {
      const html = PAGE.replace('</body>', `<div data-x="${real}"></div></body>`);
      expect(() => rewriteViewerHtml(html, makeCtx(), PUBLIC_HOST)).toThrowError(AdapterError);
    }
  });

  test('rewriteViewerHtml rejects an unsafe public host', () => {
    for (const host of ['', "a'b", 'a b', 'a\nb', '</script>', "x';alert(1);'"]) {
      expect(() => rewriteViewerHtml(PAGE, makeCtx(), host)).toThrowError(AdapterError);
    }
  });
});
