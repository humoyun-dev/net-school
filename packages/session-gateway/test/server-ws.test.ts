import type { IncomingHttpHeaders } from 'node:http';
import https, { createServer as createHttps, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import tls from 'node:tls';
import { makeCert, tick, until } from '@netschool/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { RemoteSessionBroker } from '../src/broker.ts';
import { SessionRegistry } from '../src/registry.ts';
import { createGateway, GATEWAY_COOKIE, type Gateway, type GatewayOptions } from '../src/server.ts';
import { TicketStore } from '../src/tickets.ts';
import type { GatewayEvent } from '../src/types.ts';
import { FakeViewerUpstream } from './support/fake-upstream.ts';

const PUBLIC_ORIGIN = 'https://localhost:9443';

const req = (n: number) => ({
  sessionId: `rs-${n}`,
  actorId: 'teacher-1',
  device: { meshInstanceId: 'mc', meshDomainId: '', meshNodeId: 'node//abc' },
  mode: 'view' as const,
});

interface UpstreamConn {
  ws: WebSocket;
  url: string;
  headers: IncomingHttpHeaders;
  received: Array<{ data: Buffer; isBinary: boolean }>;
  closed: boolean;
}

let cert: Awaited<ReturnType<typeof makeCert>>;
let upstreamServer: Server;
let upstreamWss: WebSocketServer;
let conns: UpstreamConn[];
let upgradeDelayMs: number;
let upgradeStatus: number | undefined;
let upgradeHang: boolean;
let gateway: Gateway;
let port: number;
let events: GatewayEvent[];
let fake: FakeViewerUpstream;
let tickets: TicketStore;
let registry: SessionRegistry;
let broker: RemoteSessionBroker;
const rawSockets = new Set<Socket>();
const clients = new Set<WebSocket>();

async function start(
  extra: Partial<GatewayOptions> = {},
  upstreamOverride: Partial<GatewayOptions['upstream']> = {},
): Promise<void> {
  cert = await makeCert('localhost');
  conns = [];
  events = [];
  upgradeDelayMs = 0;
  upgradeStatus = undefined;
  upgradeHang = false;
  upstreamServer = createHttps({ key: cert.key, cert: cert.cert }, (_rq, rs) => {
    rs.writeHead(404);
    rs.end();
  });
  upstreamWss = new WebSocketServer({ noServer: true });
  upstreamServer.on('connection', (s: Socket) => rawSockets.add(s));
  upstreamServer.on('upgrade', (rq, socket, head) => {
    const go = () => {
      if (upgradeHang) return;
      if (upgradeStatus !== undefined) {
        socket.end(`HTTP/1.1 ${upgradeStatus} Nope\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      upstreamWss.handleUpgrade(rq, socket, head, (ws) => {
        const conn: UpstreamConn = { ws, url: rq.url ?? '', headers: rq.headers, received: [], closed: false };
        conns.push(conn);
        ws.on('message', (data, isBinary) => conn.received.push({ data: data as Buffer, isBinary }));
        ws.on('close', () => {
          conn.closed = true;
        });
      });
    };
    if (upgradeDelayMs > 0) setTimeout(go, upgradeDelayMs);
    else go();
  });
  await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstreamServer.address() as AddressInfo).port;

  fake = new FakeViewerUpstream();
  tickets = new TicketStore({ now: () => 1_000_000 });
  registry = new SessionRegistry();
  const onEvent = (e: GatewayEvent) => events.push(e);
  broker = new RemoteSessionBroker({ upstream: fake, tickets, registry, onEvent });
  gateway = createGateway({
    tls: cert,
    upstream: {
      origin: `https://127.0.0.1:${upstreamPort}`,
      ca: cert.cert,
      servername: 'localhost',
      ...upstreamOverride,
    },
    broker,
    tickets,
    registry,
    publicOrigin: PUBLIC_ORIGIN,
    ...extra,
    onEvent,
  });
  port = await gateway.listen(0, '127.0.0.1');
}

const sess = (i: number) => {
  const found = fake.sessions[i];
  if (!found) throw new Error(`no fake session ${i}`);
  return found;
};
const conn = (i: number) => {
  const found = conns[i];
  if (!found) throw new Error(`no upstream connection ${i}`);
  return found;
};

// Sessiya ochadi, ticketni redeem qiladi va cookie qiymatini qaytaradi.
async function login(n: number): Promise<string> {
  const { ticket } = await broker.open(req(n));
  return redeem(ticket);
}

async function redeem(ticket: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        ca: cert.cert,
        path: `/rs/redeem?ticket=${ticket}`,
        agent: false,
      },
      (rs) => {
        rs.resume();
        const raw = String(rs.headers['set-cookie']?.[0]);
        resolve(raw.split(';')[0]?.slice(GATEWAY_COOKIE.length + 1) ?? '');
      },
    );
    r.on('error', reject);
    r.end();
  });
}

const wsHeaders = (cookieValue: string | undefined, origin: string | null = PUBLIC_ORIGIN) => ({
  ...(cookieValue === undefined ? {} : { cookie: `${GATEWAY_COOKIE}=${cookieValue}` }),
  ...(origin === null ? {} : { origin }),
});

function newClient(path: string, headers: Record<string, string>): WebSocket {
  const options = { ca: cert.cert, servername: 'localhost', headers }; // servername ws tiplarida yo'q, https'ga o'tadi
  const c = new WebSocket(`wss://127.0.0.1:${port}${path}`, options);
  clients.add(c);
  return c;
}

interface Browser {
  ws: WebSocket;
  messages: Array<{ data: Buffer; isBinary: boolean }>;
  closeCode: () => number | undefined;
}

async function openBrowser(cookieValue: string, path = '/control.ashx'): Promise<Browser> {
  const ws = newClient(path, wsHeaders(cookieValue));
  const messages: Browser['messages'] = [];
  let code: number | undefined;
  ws.on('message', (data, isBinary) => messages.push({ data: data as Buffer, isBinary }));
  ws.on('close', (c) => {
    code = c;
  });
  ws.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, res) => reject(new Error(`upgrade rejected: ${res.statusCode}`)));
  });
  return { ws, messages, closeCode: () => code };
}

// Rad etilgan upgrade'ning HTTP status'ini qaytaradi ('open' bo'lsa ulangan).
function attempt(path: string, headers: Record<string, string>): Promise<number | 'open'> {
  return new Promise((resolve, reject) => {
    const c = newClient(path, headers);
    c.on('unexpected-response', (_q, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    c.on('open', () => resolve('open'));
    c.on('error', reject);
  });
}

// Xom TLS orqali yuborilgan so'rovning birinchi status qatori.
function rawStatus(requestLine: string, headers: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: cert.cert }, () => {
      s.write(`${[requestLine, 'Host: localhost:9443', ...headers].join('\r\n')}\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n')) {
        resolve(buf.split('\r\n')[0] ?? '');
        s.destroy();
      }
    });
    s.on('close', () => resolve(buf.split('\r\n')[0] ?? ''));
    s.on('error', reject);
  });
}

beforeEach(() => start());
afterEach(async () => {
  for (const c of clients) c.terminate();
  clients.clear();
  await gateway.close().catch(() => {}); // ba'zi testlar o'zi yopadi
  for (const s of rawSockets) s.destroy();
  rawSockets.clear();
  await new Promise<void>((r) => upstreamServer.close(() => r()));
});

// Gateway va upstream'ni boshqa sozlama bilan qayta ishga tushiradi.
async function restart(
  extra: Partial<GatewayOptions>,
  upstreamOverride: Partial<GatewayOptions['upstream']> = {},
): Promise<void> {
  await gateway.close();
  for (const s of rawSockets) s.destroy();
  await new Promise<void>((r) => upstreamServer.close(() => r()));
  await start(extra, upstreamOverride);
}

describe('gateway WS: upgrade checks', () => {
  test('upgrade without session cookie is rejected', async () => {
    expect(await attempt('/control.ashx', wsHeaders(undefined))).toBe(401);
    expect(await attempt('/control.ashx', wsHeaders('not-a-real-cookie'))).toBe(401);
    expect(conns).toHaveLength(0);
  });

  test('upgrade with a closed session cookie is rejected', async () => {
    const value = await login(1);
    await registry.close('rs-1', 'revoked');
    expect(await attempt('/control.ashx', wsHeaders(value))).toBe(401);
    expect(conns).toHaveLength(0);
  });

  test('upgrade with foreign or missing Origin is rejected and never reaches routeWs', async () => {
    const value = await login(1);
    expect(await attempt('/control.ashx', wsHeaders(value, 'https://evil.example'))).toBe(403);
    expect(await attempt('/control.ashx', wsHeaders(value, `${PUBLIC_ORIGIN}/`))).toBe(403);
    expect(await attempt('/control.ashx', wsHeaders(value, null))).toBe(403);
    expect(sess(0).routedWs).toEqual([]);
    expect(conns).toHaveLength(0);
  });

  test('denied ws route is rejected, emits route_denied and does not contact upstream', async () => {
    const value = await login(1);
    sess(0).wsVerdict = { ok: false, reason: 'ws_path_not_allowed' };
    expect(await attempt('/control.ashx', wsHeaders(value))).toBe(403);
    expect(events).toContainEqual({
      type: 'route_denied',
      sessionId: 'rs-1',
      kind: 'ws',
      path: '/control.ashx',
      reason: 'ws_path_not_allowed',
    });
    expect(conns).toHaveLength(0);
  });

  test('allowed route with an unknown channel path is rejected', async () => {
    const value = await login(1);
    expect(await attempt('/other.ashx', wsHeaders(value))).toBe(403);
    expect(conns).toHaveLength(0);
  });

  test('request targets that are not a single-slash path are rejected with 400', async () => {
    const value = await login(1);
    const upgrade = [
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      `Origin: ${PUBLIC_ORIGIN}`,
      `Cookie: ${GATEWAY_COOKIE}=${value}`,
    ];
    for (const target of ['//evil/x', '/\\evil/x', 'https://evil.example/control.ashx', '*']) {
      expect(await rawStatus(`GET ${target} HTTP/1.1`, upgrade)).toBe('HTTP/1.1 400 Bad Request');
    }
    expect(sess(0).routedWs).toEqual([]);
    expect(conns).toHaveLength(0);
  });

  test('non-websocket upgrade is rejected', async () => {
    const value = await login(1);
    const status = await rawStatus('GET /control.ashx HTTP/1.1', [
      'Connection: Upgrade',
      'Upgrade: h2c',
      `Origin: ${PUBLIC_ORIGIN}`,
      `Cookie: ${GATEWAY_COOKIE}=${value}`,
    ]);
    expect(status).toBe('HTTP/1.1 400 Bad Request');
    expect(conns).toHaveLength(0);
  });
});

describe('gateway HTTP: request target check', () => {
  test('protocol-relative and backslash request targets are rejected with 400', async () => {
    for (const target of ['//evil/x', '/\\evil/x', 'https://evil.example/rs/redeem']) {
      expect(await rawStatus(`GET ${target} HTTP/1.1`, ['Connection: close'])).toBe('HTTP/1.1 400 Bad Request');
    }
  });
});

describe('gateway WS: proxying', () => {
  test('upstream handshake carries sanitized headers, requestHeaders(), gateway-set X-Forwarded-For and upstream Origin', async () => {
    const value = await login(1);
    sess(0).headers = { cookie: 'xid=upstream-secret', 'x-meshauth': 'tok' };
    sess(0).wsVerdict = { ok: true, upstreamPath: '/ws-up?x=1' };
    const ws = newClient('/control.ashx', {
      ...wsHeaders(value),
      authorization: 'Bearer browser',
      'x-forwarded-for': '6.6.6.6',
      'x-real-ip': '6.6.6.6',
      'user-agent': 'ua-test',
    });
    ws.on('error', () => {});
    await until(() => conns.length === 1);
    const up = conn(0);
    expect(up.url).toBe('/ws-up?x=1');
    expect(up.headers.cookie).toBe('xid=upstream-secret');
    expect(up.headers['x-meshauth']).toBe('tok');
    expect(up.headers.authorization).toBeUndefined();
    expect(up.headers['x-real-ip']).toBeUndefined();
    expect(up.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(up.headers['user-agent']).toBe('ua-test');
    expect(up.headers.origin).toBe(`https://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`);
    expect(String(up.headers.cookie)).not.toContain(GATEWAY_COOKIE);
    expect(sess(0).routedWs).toEqual(['/control.ashx']);
  });

  test('allowed frames pass both ways and keep their text/binary type', async () => {
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);

    browser.ws.send('hello-up');
    browser.ws.send(Buffer.from([1, 2, 3]));
    await until(() => conn(0).received.length === 2);
    expect(conn(0).received[0]).toEqual({ data: Buffer.from('hello-up'), isBinary: false });
    expect(conn(0).received[1]).toEqual({ data: Buffer.from([1, 2, 3]), isBinary: true });

    conn(0).ws.send('hello-down');
    conn(0).ws.send(Buffer.from([9, 8]));
    await until(() => browser.messages.length === 2);
    expect(browser.messages[0]).toEqual({ data: Buffer.from('hello-down'), isBinary: false });
    expect(browser.messages[1]).toEqual({ data: Buffer.from([9, 8]), isBinary: true });

    expect(sess(0).frames).toEqual([
      { channel: 'control', direction: 'up', data: 'hello-up', isBinary: false },
      { channel: 'control', direction: 'up', data: Buffer.from([1, 2, 3]), isBinary: true },
      { channel: 'control', direction: 'down', data: 'hello-down', isBinary: false },
      { channel: 'control', direction: 'down', data: Buffer.from([9, 8]), isBinary: true },
    ]);
  });

  test('each connection uses its own filter from routeWs for both directions', async () => {
    const value = await login(1);
    const a = await openBrowser(value);
    await until(() => conns.length === 1);
    const b = await openBrowser(value, '/meshrelay.ashx');
    await until(() => conns.length === 2);
    expect(sess(0).filterCalls).toEqual([0, 0]);

    a.ws.send('a-up');
    b.ws.send('b-up-1');
    b.ws.send('b-up-2');
    await until(() => conn(0).received.length === 1 && conn(1).received.length === 2);
    conn(1).ws.send('b-down');
    await until(() => b.messages.length === 1);

    expect(sess(0).filterCalls).toEqual([1, 3]);
    expect(sess(0).frames.map((f) => `${f.channel}:${f.direction}:${String(f.data)}`)).toEqual([
      'control:up:a-up',
      'relay:up:b-up-1',
      'relay:up:b-up-2',
      'relay:down:b-down',
    ]);
  });

  test('meshrelay.ashx frames are filtered on the relay channel', async () => {
    const value = await login(1);
    const browser = await openBrowser(value, '/meshrelay.ashx');
    await until(() => conns.length === 1);
    browser.ws.send('r');
    await until(() => conn(0).received.length === 1);
    expect(sess(0).frames[0]?.channel).toBe('relay');
  });

  test('filter output replaces the forwarded payload', async () => {
    const value = await login(1);
    sess(0).frameFilter = (_c, _d, data) => ({ ok: true, data: `filtered:${String(data)}` });
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    browser.ws.send('a');
    await until(() => conn(0).received.length === 1);
    expect(conn(0).received[0]).toEqual({ data: Buffer.from('filtered:a'), isBinary: false });
  });

  test('dropped frame does not close the connection and emits frame_dropped', async () => {
    const value = await login(1);
    sess(0).frameFilter = (_c, _d, data) =>
      String(data) === 'drop-me' ? { ok: false, reason: 'not_allowed' } : { ok: true, data };
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);

    browser.ws.send('drop-me');
    browser.ws.send('keep-up');
    await until(() => conn(0).received.length === 1);
    expect(conn(0).received[0]?.data.toString()).toBe('keep-up');

    conn(0).ws.send('drop-me');
    conn(0).ws.send('keep-down');
    await until(() => browser.messages.length === 1);
    expect(browser.messages[0]?.data.toString()).toBe('keep-down');

    expect(events.filter((e) => e.type === 'frame_dropped')).toEqual([
      { type: 'frame_dropped', sessionId: 'rs-1', channel: 'control', direction: 'up', reason: 'not_allowed' },
      { type: 'frame_dropped', sessionId: 'rs-1', channel: 'control', direction: 'down', reason: 'not_allowed' },
    ]);
    expect(browser.ws.readyState).toBe(WebSocket.OPEN);
    expect(conn(0).ws.readyState).toBe(WebSocket.OPEN);
  });

  test('connection filter throwing drops the frame, emits filter_error and closes both sides', async () => {
    const value = await login(1);
    sess(0).frameFilter = () => {
      throw new Error('session closed');
    };
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    browser.ws.send('boom');
    await until(() => browser.closeCode() !== undefined, 1000);
    expect(browser.closeCode()).toBe(1011);
    await until(() => conn(0).closed, 1000);
    expect(conn(0).received).toEqual([]);
    expect(events).toContainEqual({
      type: 'frame_dropped',
      sessionId: 'rs-1',
      channel: 'control',
      direction: 'up',
      reason: 'filter_error',
    });
    expect(sess(0).frames).toHaveLength(1);
  });

  test('downstream connection filter throwing also closes both sides', async () => {
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    sess(0).frameFilter = () => {
      throw new Error('boom');
    };
    conn(0).ws.send('x');
    await until(() => browser.closeCode() !== undefined, 1000);
    expect(browser.closeCode()).toBe(1011);
    expect(events).toContainEqual({
      type: 'frame_dropped',
      sessionId: 'rs-1',
      channel: 'control',
      direction: 'down',
      reason: 'filter_error',
    });
  });

  test('frames sent before upstream is open are delivered in order', async () => {
    upgradeDelayMs = 250;
    const value = await login(1);
    const browser = await openBrowser(value);
    browser.ws.send('one');
    browser.ws.send(Buffer.from([2]));
    browser.ws.send('three');
    await tick(50);
    expect(conns).toHaveLength(0);
    await until(() => conns[0]?.received.length === 3);
    expect(conn(0).received.map((m) => [m.data.toString('hex'), m.isBinary])).toEqual([
      [Buffer.from('one').toString('hex'), false],
      ['02', true],
      [Buffer.from('three').toString('hex'), false],
    ]);
  });

  test('queued frames pass through the filter when flushed; a dropped one is skipped', async () => {
    upgradeDelayMs = 150;
    const value = await login(1);
    sess(0).frameFilter = (_c, _d, data) => (String(data) === 'bad' ? { ok: false, reason: 'no' } : { ok: true, data });
    const browser = await openBrowser(value);
    browser.ws.send('a');
    browser.ws.send('bad');
    browser.ws.send('b');
    await until(() => conns[0]?.received.length === 2);
    expect(conn(0).received.map((m) => m.data.toString())).toEqual(['a', 'b']);
  });

  test('more than 1 MiB queued before upstream is open closes the browser with 1009', async () => {
    upgradeDelayMs = 1_000;
    const value = await login(1);
    const browser = await openBrowser(value);
    browser.ws.send(Buffer.alloc(600 * 1024, 1));
    browser.ws.send(Buffer.alloc(600 * 1024, 2));
    await until(() => browser.closeCode() !== undefined, 800);
    expect(browser.closeCode()).toBe(1009);
    expect(sess(0).frames).toEqual([]); // navbat to'lib ketsa filtrga ham yetmaydi
  });
});

describe('gateway WS: backpressure', () => {
  const FRAME = 16 * 1024;
  const FRAMES = 1_200; // ~19 MB: yadro bufferlaridan ancha katta

  // Birinchi 4 bayt: tartib raqami.
  const frame = (n: number): Buffer => {
    const b = Buffer.alloc(FRAME, 7);
    b.writeUInt32BE(n, 0);
    return b;
  };

  test('paused browser pauses the upstream source instead of buffering without bound', async () => {
    await restart({ wsHighWaterMark: 64 * 1024 });
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    browser.ws.pause(); // brauzer o'qimaydi

    for (let n = 0; n < FRAMES; n++) conn(0).ws.send(frame(n));
    await tick(600);

    // Gateway upstream'dan o'qishni to'xtatgan: oqim upstream tomonda qolgan, gateway xotirasida emas.
    expect(conn(0).ws.bufferedAmount).toBeGreaterThan(4 * 1024 * 1024);
    expect(browser.closeCode()).toBeUndefined(); // juft yopilmagan
    expect(sess(0).frames.length).toBeLessThan(FRAMES / 2);
  });

  test('resumed browser drains and the stream continues', async () => {
    await restart({ wsHighWaterMark: 64 * 1024 });
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    browser.ws.pause();
    for (let n = 0; n < FRAMES; n++) conn(0).ws.send(frame(n));
    await tick(300);
    expect(sess(0).frames.length).toBeLessThan(FRAMES);

    browser.ws.resume();
    await until(() => browser.messages.length === FRAMES, 10_000);
    expect(browser.messages.map((m) => m.data.readUInt32BE(0))).toEqual(Array.from({ length: FRAMES }, (_, n) => n));
    expect(conn(0).ws.bufferedAmount).toBe(0);
    expect(browser.closeCode()).toBeUndefined();
  });

  test('a paused upstream pauses the browser source in the up direction', async () => {
    await restart({ wsHighWaterMark: 64 * 1024 });
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    conn(0).ws.pause(); // upstream o'qimaydi

    for (let n = 0; n < FRAMES; n++) browser.ws.send(frame(n));
    await tick(600);
    expect(browser.ws.bufferedAmount).toBeGreaterThan(4 * 1024 * 1024);
    expect(browser.closeCode()).toBeUndefined();

    conn(0).ws.resume();
    await until(() => conn(0).received.length === FRAMES, 10_000);
    expect(conn(0).received.map((m) => m.data.readUInt32BE(0))).toEqual(Array.from({ length: FRAMES }, (_, n) => n));
  });

  test('exceeding 4x the high-water mark closes the pair with 1008 and emits upstream_error', async () => {
    await restart({ wsHighWaterMark: 16 * 1024 });
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    conn(0).ws.send(Buffer.alloc(128 * 1024, 1)); // 128 KiB > 4 * 16 KiB
    await until(() => browser.closeCode() !== undefined, 1000);
    expect(browser.closeCode()).toBe(1008);
    await until(() => conn(0).closed, 1000);
    expect(events).toContainEqual({ type: 'upstream_error', sessionId: 'rs-1', message: 'backpressure' });
    expect(browser.messages).toEqual([]);
  });
});

describe('gateway WS: disconnect', () => {
  test('registry close() closes both browser and upstream sockets within 1 s', async () => {
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    expect(registry.get('rs-1')?.sockets.size).toBe(1);

    const started = Date.now();
    await registry.close('rs-1', 'revoked');
    await until(() => browser.closeCode() !== undefined && conn(0).closed, 1000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(browser.closeCode()).toBe(1008);
    await until(() => registry.get('rs-1')?.sockets.size === 0, 1000);
    expect(sess(0).revokeCalls).toBe(1);
  });

  test('close() closes sockets even when upstream revoke fails', async () => {
    fake.nextRevokeError = new Error('revoke failed');
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);

    await expect(registry.close('rs-1', 'revoked')).rejects.toThrow('revoke failed');
    await until(() => browser.closeCode() !== undefined && conn(0).closed, 1000);
    expect(browser.closeCode()).toBe(1008);
  });

  test('close() closes both sockets with 1008 within 1 s while upstream revoke hangs', async () => {
    fake.nextRevokeHang = true;
    const value = await login(1);
    const control = await openBrowser(value);
    await until(() => conns.length === 1);
    const relay = await openBrowser(value, '/meshrelay.ashx');
    await until(() => conns.length === 2);

    let settled = false;
    void registry.close('rs-1', 'revoked').finally(() => {
      settled = true;
    });
    const started = Date.now();
    await until(
      () => control.closeCode() !== undefined && relay.closeCode() !== undefined && conn(0).closed && conn(1).closed,
      1_000,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([control.closeCode(), relay.closeCode()]).toEqual([1008, 1008]);
    expect(sess(0).revokeCalls).toBe(1);
    expect(settled).toBe(false);
  });

  test('a browser that never acknowledges the close frame is terminated after 1 s', async () => {
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    browser.ws.pause(); // close kadri o'qilmaydi, javob ham yo'q
    await registry.close('rs-1', 'revoked');
    await until(() => conn(0).closed, 500); // upstream kutilmaydi
    expect(browser.closeCode()).toBeUndefined();
    await tick(300);
    expect(registry.get('rs-1')?.sockets.size).toBe(1); // 1 s kutiladi
    await until(() => registry.get('rs-1')?.sockets.size === 0, 2000); // gateway tomoni soketni uzdi
  });

  test('upstream close closes the browser socket and propagates a valid code', async () => {
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    conn(0).ws.close(4001);
    await until(() => browser.closeCode() !== undefined, 1000);
    expect(browser.closeCode()).toBe(4001);
    expect(registry.get('rs-1')?.sockets.size).toBe(0);
  });

  test('abnormal upstream termination closes the browser with 1000', async () => {
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    conn(0).ws.terminate();
    await until(() => browser.closeCode() !== undefined, 1000);
    expect(browser.closeCode()).toBe(1000);
  });

  test('browser close terminates the upstream socket and unregisters the handle', async () => {
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    browser.ws.close(1000);
    await until(() => conn(0).closed, 1000);
    expect(registry.get('rs-1')?.sockets.size).toBe(0);
  });

  test('session closed while upstream is still connecting leaks nothing', async () => {
    upgradeDelayMs = 300;
    const value = await login(1);
    const browser = await openBrowser(value);
    await registry.close('rs-1', 'revoked');
    await until(() => browser.closeCode() !== undefined, 1000);
    expect(browser.closeCode()).toBe(1008);
    expect(registry.get('rs-1')?.sockets.size).toBe(0);
    await tick(450); // kechikkan upstream upgrade tugasa ham hech narsa ulanib qolmaydi
    for (const c of conns) await until(() => c.closed, 1000);
    expect(events.filter((e) => e.type === 'upstream_error')).toEqual([]);
  });

  test('gateway.close() terminates proxied sockets', async () => {
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => conns.length === 1);
    const closing = gateway.close();
    await until(() => browser.closeCode() !== undefined && conn(0).closed, 1500);
    await closing;
  });
});

describe('gateway WS: upstream failures', () => {
  test('upstream refusing the upgrade closes the browser with 1011 and emits upstream_error', async () => {
    upgradeStatus = 403;
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => browser.closeCode() !== undefined, 1000);
    expect(browser.closeCode()).toBe(1011);
    expect(events.filter((e) => e.type === 'upstream_error')).toHaveLength(1);
    expect(registry.get('rs-1')?.sockets.size).toBe(0);
  });

  test('upstream handshake timeout closes the browser with 1011', async () => {
    await restart({ upstreamTimeoutMs: 150 });
    upgradeHang = true;
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => browser.closeCode() !== undefined, 1500);
    expect(browser.closeCode()).toBe(1011);
    expect(events.filter((e) => e.type === 'upstream_error')).toHaveLength(1);
  });

  test('upstream TLS verification failure closes the browser with 1011', async () => {
    const other = await makeCert('localhost');
    await restart({}, { ca: other.cert });
    const value = await login(1);
    const browser = await openBrowser(value);
    await until(() => browser.closeCode() !== undefined, 1500);
    expect(browser.closeCode()).toBe(1011);
    expect(events.filter((e) => e.type === 'upstream_error')).toHaveLength(1);
  });

  test('requestHeaders() failure rejects the upgrade without contacting upstream', async () => {
    const value = await login(1);
    sess(0).headersError = new Error('closed');
    expect(await attempt('/control.ashx', wsHeaders(value))).toBe(502);
    expect(sess(0).routedWs).toEqual(['/control.ashx']); // routeWs requestHeaders()dan oldin
    expect(events.filter((e) => e.type === 'upstream_error')).toHaveLength(1);
    expect(conns).toHaveLength(0);
  });
});
