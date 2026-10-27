import type { IncomingMessage } from 'node:http';
import { AdapterError, loginPrincipal } from '@netschool/meshcentral-adapter';
import { tick, until } from '@netschool/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { type Browser, type GatewayStack, startGatewayStack } from './harness/gateway.ts';
import { type MeshCentralInstance, startMeshCentral } from './harness/meshcentral.ts';

const CLIENT_IP = '127.0.0.1';
// Node'ga bog'langan ruxsat etilgan amallar. Agentsiz node uchun faqat powertimeline haqiqiy javob beradi
// (getsysinfo/lastconnect "Invalid device id"/"No data"). Javoblarda responseid yo'q: action + nodeid bo'yicha moslanadi.
const OWN_REPLY_ACTION = 'powertimeline';
const NODE_ACTIONS = ['getsysinfo', 'getnetworkinfo', 'lastconnect', 'powertimeline'];

let mc: MeshCentralInstance;
let stack: GatewayStack;
let clock = 0; // ticket TTL sinovi uchun soxta soat siljishi
let seq = 0;
const opened: string[] = [];

interface Started {
  sessionId: string;
  ticket: string;
  browser: Browser;
  nodeId: string;
  entryPath: string;
}

// Yangi sessiya (har testga alohida principal) va redeem; brauzer cookie'si saqlanadi.
async function start(mode: 'view' | 'control' = 'view', name = 'pc-01'): Promise<Started> {
  const sessionId = `s-${++seq}`;
  const device = await stack.device(name);
  const { ticket } = await stack.broker.open({ sessionId, actorId: 'u-1', device, mode });
  opened.push(sessionId);
  const browser = stack.browser();
  const redeemed = await browser.redeem(ticket);
  expect(redeemed.status).toBe(303);
  const entryPath = String(redeemed.headers.location);
  const nodeId = stack.nodeIdOf(device);
  return { sessionId, ticket, browser, nodeId, entryPath };
}

interface Tracked {
  ws: WebSocket;
  frames: string[];
}

function track(ws: WebSocket): Tracked {
  const tracked: Tracked = { ws, frames: [] };
  ws.on('message', (data) => tracked.frames.push(data.toString()));
  ws.on('error', () => {});
  return tracked;
}

function whenOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res: IncomingMessage) => reject(new Error(`upgrade ${res.statusCode}`)));
  });
}

// Upgrade holati: 'open' yoki rad etilgan HTTP status.
function upgrade(ws: WebSocket): Promise<number | 'open'> {
  return new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('unexpected-response', (_req, res: IncomingMessage) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once('error', () => resolve(0));
  });
}

async function openControl(s: Started): Promise<Tracked> {
  const control = track(s.browser.socket('/control.ashx'));
  await whenOpen(control.ws);
  return control;
}

function relayPath(nodeId: string, handle: string, extra = ''): string {
  return `/meshrelay.ashx?browser=1&p=2&nodeid=${encodeURIComponent(nodeId)}&id=abc&auth=${encodeURIComponent(handle)}${extra}`;
}

function parsed(frames: string[]): Record<string, unknown>[] {
  return frames.flatMap((f) => {
    try {
      return [JSON.parse(f) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

async function frameWhere(
  tracked: Tracked,
  pred: (f: Record<string, unknown>) => boolean,
  ms = 8_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = parsed(tracked.frames).find(pred);
    if (hit) return hit;
    await tick(25);
  }
  throw new Error(`frame not received in ${ms} ms; got actions: ${parsed(tracked.frames).map((f) => f.action)}`);
}

async function noFrame(tracked: Tracked, pred: (f: Record<string, unknown>) => boolean, ms = 2_000): Promise<boolean> {
  await tick(ms);
  return !parsed(tracked.frames).some(pred);
}

function droppedFor(sessionId: string) {
  return stack.events.flatMap((e) => (e.type === 'frame_dropped' && e.sessionId === sessionId ? [e] : []));
}

function pageValue(html: string, name: 'authCookie' | 'authRelayCookie'): string {
  const value = new RegExp(`var ${name} = '([^']+)';`).exec(html)?.[1];
  if (!value) throw new Error(`entry page has no ${name}`);
  return value;
}

// ws klient tomoni: 'close' kodi yoki `ms` ichida yopilmasa undefined. Tinglovchi yopishdan OLDIN o'rnatiladi.
function closeCodeWithin(ws: WebSocket, ms: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// MeshCentral rad etgan soket tez CLOSING bo'ladi, lekin 'close' ~30 s kechikadi: readyState kuzatiladi.
function directOutcome(ws: WebSocket, ms: number): Promise<'open' | 'not-open'> {
  return new Promise((resolve) => {
    let watch: NodeJS.Timeout | undefined;
    const finish = (result: 'open' | 'not-open') => {
      clearInterval(watch);
      resolve(result);
      ws.terminate();
    };
    ws.on('open', () => {
      const deadline = Date.now() + ms;
      watch = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) finish('not-open');
        else if (Date.now() >= deadline) finish('open');
      }, 20);
    });
    ws.on('error', () => finish('not-open'));
    ws.on('unexpected-response', () => finish('not-open'));
    ws.on('close', () => finish('not-open'));
  });
}

beforeAll(async () => {
  mc = await startMeshCentral();
  stack = await startGatewayStack(mc, { now: () => Date.now() + clock });
});

afterAll(async () => {
  for (const id of opened) await stack?.broker.close(id).catch(() => {});
  await stack?.stop();
  await mc?.stop();
});

describe('session gateway against pinned MeshCentral', () => {
  test('scoped identity: viewer session lists only the session node', async () => {
    const s = await start();
    await s.browser.get(s.entryPath);
    const control = await openControl(s);
    control.ws.send(JSON.stringify({ action: 'nodes', responseid: 'n1' }));
    const reply = await frameWhere(control, (f) => f.action === 'nodes');
    const groups = Object.values((reply.nodes ?? {}) as Record<string, { name: string }[]>);
    expect(groups.flat().map((n) => n.name)).toEqual(['pc-01']);
    control.ws.close();
  });

  test('cookie and websocket routing work end to end', async () => {
    const s = await start();
    const page = await s.browser.get(s.entryPath);
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/var authCookie = 'nsh_/);
    const control = await openControl(s);
    const info = await frameWhere(control, (f) => f.action === 'serverinfo');
    expect(info.action).toBe('serverinfo');
    control.ws.close();
  });

  test('no MeshCentral credential reaches the browser', async () => {
    const s = await start();
    const seen: string[] = [];
    const page = await s.browser.get(s.entryPath);
    expect(page.status).toBe(200);
    seen.push(JSON.stringify(page.headers), page.body);
    const assetPath = /(?:src|href)="\/?((?:scripts|styles)\/[A-Za-z0-9._~@/-]+)"/.exec(page.body)?.[1];
    expect(assetPath).toBeDefined();
    const asset = await s.browser.get(`/${assetPath}`);
    expect(asset.status).toBe(200);
    seen.push(JSON.stringify(asset.headers), asset.body);

    const control = await openControl(s);
    control.ws.send(JSON.stringify({ action: 'authcookie', responseid: 'a1' }));
    await frameWhere(control, (f) => f.action === 'authcookie');
    seen.push(...control.frames);
    control.ws.close();

    // Redeem javobi: set-cookie faqat gateway cookie'si.
    expect(s.browser.redeemSetCookie).toHaveLength(1);
    expect(s.browser.redeemSetCookie[0]).toMatch(/^__Host-ns_rs=[A-Za-z0-9_-]{43};/);
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(asset.headers['set-cookie']).toBeUndefined();

    const real = stack.credentialsOf(s.sessionId);
    const secrets = [
      real.password,
      ...real.upstreamCookies,
      ...real.pageCookies,
      ...real.controlCookies, // authcookie javobidagi real cookie/rcookie
    ];
    expect(real.upstreamCookies.length).toBeGreaterThanOrEqual(2); // xid, xid.sig
    expect(real.pageCookies.length).toBe(2); // authCookie, authRelayCookie
    expect(real.controlCookies.length).toBeGreaterThanOrEqual(1);
    const visible = [...seen, ...s.browser.redeemHeaders].join('\n');
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(8);
      expect(visible).not.toContain(secret);
      expect(visible).not.toContain(encodeURIComponent(secret));
    }
  });

  test('direct relay bypass with browser-visible values fails', async () => {
    const s = await start();
    const page = await s.browser.get(s.entryPath);
    const handle = pageValue(page.body, 'authCookie');
    const real = stack.credentialsOf(s.sessionId).pageCookies[0] ?? '';
    const xff = { 'x-forwarded-for': CLIENT_IP };

    // Ijobiy nazorat: real cookie bilan MeshCentral relay'i ochiladi, ya'ni bypass xavfi haqiqiy.
    expect(await directOutcome(stack.directSocket(relayPath(s.nodeId, real), xff), 1_000)).toBe('open');
    // Brauzerga ko'rinadigan handle upstream uchun hech narsa emas.
    expect(await directOutcome(stack.directSocket(relayPath(s.nodeId, handle), xff), 2_000)).toBe('not-open');
    // Ijobiy nazorat: real authCookie control.ashx'da ham `auth=` bilan ochiladi, shu sabab quyidagi rad etishlar auth tufayli.
    expect(await directOutcome(stack.directSocket(`/control.ashx?auth=${encodeURIComponent(real)}`, xff), 1_000)).toBe(
      'open',
    );
    // control.ashx: handle auth sifatida ham, gateway cookie'si bilan ham rad.
    expect(
      await directOutcome(stack.directSocket(`/control.ashx?auth=${encodeURIComponent(handle)}`, xff), 2_000),
    ).toBe('not-open');
    expect(
      await directOutcome(stack.directSocket('/control.ashx', { ...xff, cookie: s.browser.cookieHeader() }), 2_000),
    ).toBe('not-open');
  });

  test('node swap attempts are denied', async () => {
    const s = await start();
    const other = stack.nodeIdOf(await stack.device('pc-02'));
    const page = await s.browser.get(s.entryPath);
    const handle = pageValue(page.body, 'authCookie');

    const otherKey = other.replace(/^node\/[^/]*\//, '');
    const swapped = await s.browser.get(`/?gotonode=${encodeURIComponent(otherKey)}&viewmode=11&hide=31`);
    expect(swapped.status).toBe(403);
    expect(await upgrade(s.browser.socket(relayPath(other, handle)))).toBe(403);

    const control = await openControl(s);

    // Ijobiy nazorat: o'z node'i uchun powertimeline javobi keladi.
    control.ws.send(JSON.stringify({ action: OWN_REPLY_ACTION, nodeid: s.nodeId }));
    await frameWhere(control, (f) => f.action === OWN_REPLY_ACTION && f.nodeid === s.nodeId);

    // Boshqa node uchun har bir amal gateway'da tashlanadi va hech qanday javob kelmaydi.
    for (const action of NODE_ACTIONS) control.ws.send(JSON.stringify({ action, nodeid: other }));
    control.ws.send(JSON.stringify({ action: 'getNotes', id: other }));
    await until(() => droppedFor(s.sessionId).length >= NODE_ACTIONS.length + 1, 3_000);
    expect(droppedFor(s.sessionId).map((e) => e.reason)).toEqual([
      ...NODE_ACTIONS.map((a) => `action:${a}`),
      'action:getNotes',
    ]);
    expect(await noFrame(control, (f) => f.nodeid === other || f.id === other)).toBe(true);
    control.ws.close();
  });

  test('view-only session cannot send agent msg commands', async () => {
    const s = await start('view');
    await s.browser.get(s.entryPath);
    const control = await openControl(s);
    const commands = [
      { type: 'pskill', pid: 4 },
      { type: 'serviceStop', serviceName: 'x' },
      { type: 'openUrl', url: 'https://example.com' },
    ];
    for (const command of commands) {
      control.ws.send(JSON.stringify({ action: 'msg', nodeid: s.nodeId, ...command }));
    }
    await until(() => droppedFor(s.sessionId).length >= commands.length, 3_000);
    expect(droppedFor(s.sessionId).map((e) => e.reason)).toEqual(['msg:pskill', 'msg:serviceStop', 'msg:openUrl']);
    // Ulanish ochiq va ruxsat etilgan kadr ishlaydi: filtr kadrni tashlaydi, sessiyani emas.
    control.ws.send(JSON.stringify({ action: 'ping' }));
    await frameWhere(control, (f) => f.action === 'pong');
    control.ws.close();
  });

  test('tcp tunnel requests are denied', async () => {
    const s = await start();
    const page = await s.browser.get(s.entryPath);
    const handle = pageValue(page.body, 'authCookie');
    const relayHandle = pageValue(page.body, 'authRelayCookie');

    expect(await upgrade(s.browser.socket(relayPath(s.nodeId, handle, '&tcpport=22')))).toBe(403);
    expect(
      await upgrade(
        s.browser.socket(
          `/meshrelay.ashx?nodeid=${encodeURIComponent(s.nodeId)}&tcpport=22&id=abc&p=2&browser=1&auth=${handle}`,
        ),
      ),
    ).toBe(403);

    const control = await openControl(s);
    const tunnel = (query: string) =>
      JSON.stringify({
        action: 'msg',
        type: 'tunnel',
        nodeid: s.nodeId,
        usage: 2,
        value: `*/meshrelay.ashx?${query}`,
      });
    const nodeQuery = `nodeid=${encodeURIComponent(s.nodeId)}`;
    control.ws.send(tunnel(`p=2&${nodeQuery}&id=abc&rauth=${relayHandle}&tcpport=22`));
    control.ws.send(tunnel(`p=2&tcpport=22&${nodeQuery}&id=abc&rauth=${relayHandle}`));
    await until(() => droppedFor(s.sessionId).length >= 2, 3_000);
    expect(droppedFor(s.sessionId).every((e) => e.reason === 'msg:tunnel')).toBe(true);

    // Ijobiy nazorat: tcpport'siz tunnel tashlanmaydi.
    const before = droppedFor(s.sessionId).length;
    control.ws.send(tunnel(`p=2&${nodeQuery}&id=abc&rauth=${relayHandle}`));
    await tick(500);
    expect(droppedFor(s.sessionId)).toHaveLength(before);
    control.ws.close();
  });

  test('stale and replayed tickets are rejected', async () => {
    // Eskirgan: ticket 30 s'dan keyin.
    const sessionId = `s-${++seq}`;
    const { ticket } = await stack.broker.open({
      sessionId,
      actorId: 'u-1',
      device: await stack.device('pc-01'),
      mode: 'view',
    });
    opened.push(sessionId);
    clock = 31_000;
    try {
      expect((await stack.browser().redeem(ticket)).status).toBe(403);
    } finally {
      clock = 0;
    }
    expect(stack.events).toContainEqual({ type: 'ticket_rejected', reason: 'expired' });

    // Qayta ishlatilgan: ikkinchi redeem.
    const s = await start();
    const again = stack.browser();
    const replayed = await again.redeem(s.ticket);
    expect(replayed.status).toBe(403);
    expect(again.cookieHeader()).toBe('');
    expect(stack.events).toContainEqual({ type: 'ticket_rejected', reason: 'unknown' });
  });

  test('revoke closes active control and relay sockets and the principal can no longer log in', async () => {
    const s = await start();
    const page = await s.browser.get(s.entryPath);
    const handle = pageValue(page.body, 'authCookie');
    const credentials = stack.credentialsOf(s.sessionId);

    const control = await openControl(s);
    await frameWhere(control, (f) => f.action === 'serverinfo');
    // Agent yo'q: relay peer kutadi va ochiq qoladi.
    const relay = track(s.browser.socket(relayPath(s.nodeId, handle)));
    await whenOpen(relay.ws);
    await tick(500);
    expect(relay.ws.readyState).toBe(WebSocket.OPEN);

    // 2 s chegarasi close() chaqiruvidan boshlanadi: soketlar upstream revoke tugashini kutmasligi shart.
    const closing = Promise.all([closeCodeWithin(control.ws, 2_000), closeCodeWithin(relay.ws, 2_000)]);
    await stack.broker.close(s.sessionId);
    expect(await closing).toEqual([1008, 1008]);

    expect((await s.browser.get('/scripts/x.js')).status).toBe(401);
    expect(await upgrade(s.browser.socket('/control.ashx'))).toBe(401);
    const login = await loginPrincipal(
      stack.upstreamEndpoint,
      { username: credentials.username, password: credentials.password },
      CLIENT_IP,
    ).then(
      () => 'resolved',
      (err: unknown) => (err instanceof AdapterError ? err.code : String(err)),
    );
    expect(login).toBe('upstream_auth_failed');
  });
});
