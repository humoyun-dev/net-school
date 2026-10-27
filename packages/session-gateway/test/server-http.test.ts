import type { IncomingHttpHeaders } from 'node:http';
import https, { createServer as createHttps, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import tls from 'node:tls';
import { makeCert, until } from '@netschool/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { RemoteSessionBroker } from '../src/broker.ts';
import { sanitizeRequestHeaders } from '../src/headers.ts';
import { SessionRegistry } from '../src/registry.ts';
import { createGateway, GATEWAY_COOKIE, type Gateway, type GatewayOptions } from '../src/server.ts';
import { TicketStore } from '../src/tickets.ts';
import type { GatewayEvent } from '../src/types.ts';
import { FakeViewerUpstream } from './support/fake-upstream.ts';

const req = (n: number) => ({
  sessionId: `rs-${n}`,
  actorId: 'teacher-1',
  device: { meshInstanceId: 'mc', meshDomainId: '', meshNodeId: 'node//abc' },
  mode: 'view' as const,
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}
interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

let cert: Awaited<ReturnType<typeof makeCert>>;
let upstreamServer: Server;
let seen: Seen[];
let gateway: Gateway;
let port: number;
let events: GatewayEvent[];
let fake: FakeViewerUpstream;
let tickets: TicketStore;
let registry: SessionRegistry;
let broker: RemoteSessionBroker;
let now: number;
const sockets = new Set<Socket>();

const bigHtml = 'x'.repeat(2048);

async function start(extra: Partial<GatewayOptions> = {}): Promise<void> {
  cert = await makeCert('localhost');
  seen = [];
  events = [];
  now = 1_000_000;
  upstreamServer = createHttps({ key: cert.key, cert: cert.cert }, (rq, rs) => {
    seen.push({ method: rq.method ?? '', url: rq.url ?? '', headers: rq.headers });
    if (rq.url === '/cookie') {
      rs.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['xid=secret; Path=/', 'xid.sig=sig; Path=/'] });
      rs.end('with-cookie');
    } else if (rq.url === '/page') {
      rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '13' });
      rs.end('<p>hello</p>\n');
    } else if (rq.url === '/big') {
      rs.writeHead(200, { 'content-type': 'text/html' }); // chunked, content-length yo'q
      rs.end(bigHtml);
    } else if (rq.url === '/hang') {
      // hech qachon javob bermaydi
    } else if (rq.url === '/plain') {
      rs.writeHead(200, { 'content-type': 'text/plain', 'content-length': '12' });
      rs.end('entry-secret');
    } else if (rq.url === '/notype') {
      rs.writeHead(200);
      rs.end('entry-secret');
    } else if (rq.url === '/stream') {
      rs.writeHead(200, { 'content-type': 'application/octet-stream' });
      rs.write('part1-');
      rs.end('part2');
    } else {
      rs.writeHead(200, { 'content-type': 'text/plain' });
      rs.end('ok');
    }
  });
  upstreamServer.on('connection', (s: Socket) => sockets.add(s));
  await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstreamServer.address() as AddressInfo).port;

  fake = new FakeViewerUpstream();
  tickets = new TicketStore({ now: () => now });
  registry = new SessionRegistry();
  const onEvent = (e: GatewayEvent) => events.push(e);
  broker = new RemoteSessionBroker({ upstream: fake, tickets, registry, onEvent });
  gateway = createGateway({
    tls: cert,
    upstream: { origin: `https://127.0.0.1:${upstreamPort}`, ca: cert.cert, servername: 'localhost' },
    broker,
    tickets,
    registry,
    publicOrigin: 'https://localhost:9443',
    ...extra,
    onEvent,
  });
  port = await gateway.listen(0, '127.0.0.1');
}

function call(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = https.request(
      { host: '127.0.0.1', port, servername: 'localhost', ca: cert.cert, path, method, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    r.on('error', reject);
    r.end();
  });
}

// Sessiya ochadi, ticketni redeem qiladi va cookie qiymatini qaytaradi.
async function login(n: number, extra: Record<string, string> = {}): Promise<string> {
  const { ticket } = await broker.open(req(n));
  const res = await call(`/rs/redeem?ticket=${ticket}`, extra);
  expect(res.status).toBe(303);
  const raw = String(res.headers['set-cookie']?.[0]);
  return raw.split(';')[0]?.slice(GATEWAY_COOKIE.length + 1) ?? '';
}

const sess = (i: number) => {
  const found = fake.sessions[i];
  if (!found) throw new Error(`no fake session ${i}`);
  return found;
};

const cookie = (v: string) => ({ cookie: `${GATEWAY_COOKIE}=${v}` });

beforeEach(() => start());
afterEach(async () => {
  await gateway.close();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => upstreamServer.close(() => r()));
});

describe('gateway HTTP: redeem', () => {
  test('redeem sets a host-only HttpOnly Secure SameSite=Strict cookie and redirects to the entry path', async () => {
    const { ticket } = await broker.open(req(1));
    const res = await call(`/rs/redeem?ticket=${ticket}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/fake');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const setCookie = res.headers['set-cookie'] ?? [];
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(
      new RegExp(`^${GATEWAY_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=/$`),
    );
    expect(setCookie[0]).not.toMatch(/Domain|Max-Age|Expires/i);
    expect(fake.sessions[0]?.attached).toEqual(['127.0.0.1']);
  });

  test('replayed ticket is rejected with 403', async () => {
    const { ticket } = await broker.open(req(1));
    expect((await call(`/rs/redeem?ticket=${ticket}`)).status).toBe(303);
    const again = await call(`/rs/redeem?ticket=${ticket}`);
    expect(again.status).toBe(403);
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(events).toContainEqual({ type: 'ticket_rejected', reason: 'unknown' });
  });

  test('expired ticket is rejected with 403', async () => {
    const { ticket } = await broker.open(req(1));
    now += 31_000;
    expect((await call(`/rs/redeem?ticket=${ticket}`)).status).toBe(403);
    expect(events).toContainEqual({ type: 'ticket_rejected', reason: 'expired' });
  });

  test('missing ticket is rejected with 403', async () => {
    expect((await call('/rs/redeem')).status).toBe(403);
    expect(events).toEqual([{ type: 'ticket_rejected', reason: 'unknown' }]);
  });

  test('ticket of an already closed session is rejected with 403 and creates no session', async () => {
    const { ticket } = await broker.open(req(1));
    await broker.close('rs-1');
    const res = await call(`/rs/redeem?ticket=${ticket}`);
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(fake.sessions[0]?.attached).toEqual([]);
    expect(events.filter((e) => e.type === 'upstream_error')).toEqual([]);
  });

  test('redeeming a second ticket closes the superseded session', async () => {
    const first = await login(1);
    const { ticket } = await broker.open(req(2));
    const res = await call(`/rs/redeem?ticket=${ticket}`, cookie(first));
    expect(res.status).toBe(303);
    expect(registry.get('rs-1')?.closed).toBe(true);
    expect(registry.get('rs-2')?.closed).toBe(false);
    expect(fake.sessions[0]?.revokeCalls).toBe(1);
    expect(events.filter((e) => e.type === 'session_closed')).toEqual([
      { type: 'session_closed', sessionId: 'rs-1', reason: 'superseded' },
    ]);
    expect((await call('/anything', cookie(first))).status).toBe(401);
  });

  test('a failed revoke of the superseded session does not block the new session', async () => {
    const first = await login(1);
    sess(0).revokeError = new Error('mc down');
    const { ticket } = await broker.open(req(2));
    expect((await call(`/rs/redeem?ticket=${ticket}`, cookie(first))).status).toBe(303);
    await until(() => events.some((e) => e.type === 'upstream_error'));
    expect(events).toContainEqual({ type: 'upstream_error', sessionId: 'rs-1', message: 'mc down' });
    expect(events.filter((e) => e.type === 'session_closed')).toHaveLength(1);
  });

  test('failed attach returns 502 and closes the session', async () => {
    const { ticket } = await broker.open(req(1));
    sess(0).attachError = new Error('login refused: secret-detail');
    const res = await call(`/rs/redeem?ticket=${ticket}`);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('secret-detail');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(registry.get('rs-1')?.closed).toBe(true);
    await until(() => fake.sessions[0]?.revokeCalls === 1);
    expect(events).toContainEqual({
      type: 'upstream_error',
      sessionId: 'rs-1',
      message: 'login refused: secret-detail',
    });
  });
});

describe('gateway HTTP: proxy', () => {
  test('request without a session cookie gets 401', async () => {
    expect((await call('/anything')).status).toBe(401);
    expect((await call('/anything', cookie('bogus'))).status).toBe(401);
    expect(seen).toEqual([]);
  });

  test('denied route gets 403 and emits route_denied without reaching upstream', async () => {
    const c = await login(1);
    sess(0).httpVerdict = { ok: false, reason: 'path_denied' };
    const res = await call('/admin?x=1', cookie(c));
    expect(res.status).toBe(403);
    expect(seen).toEqual([]);
    expect(events).toContainEqual({
      type: 'route_denied',
      sessionId: 'rs-1',
      kind: 'http',
      path: '/admin',
      reason: 'path_denied',
    });
  });

  test('routes to the upstreamPath and streams non-html bodies', async () => {
    const c = await login(1);
    sess(0).httpVerdict = { ok: true, upstreamPath: '/stream' };
    const res = await call('/browser/path?q=1', cookie(c));
    expect(res.status).toBe(200);
    expect(res.body).toBe('part1-part2');
    expect(seen[0]?.url).toBe('/stream');
    expect(fake.sessions[0]?.routedHttp).toEqual([{ method: 'GET', url: '/browser/path?q=1' }]);
  });

  test('upstream Set-Cookie never reaches the browser and is absorbed into the session', async () => {
    const c = await login(1);
    sess(0).httpVerdict = { ok: true, upstreamPath: '/cookie' };
    const res = await call('/x', cookie(c));
    expect(res.status).toBe(200);
    expect(res.body).toBe('with-cookie');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(fake.sessions[0]?.absorbed).toEqual([['xid=secret; Path=/', 'xid.sig=sig; Path=/']]);
  });

  test('browser-supplied credential and forwarding headers are not forwarded', async () => {
    const c = await login(1);
    sess(0).headers = { cookie: 'xid=upstream-jar', 'x-forwarded-for': 'session-supplied' };
    const res = await call('/x', {
      ...cookie(c),
      'x-meshauth': 'evil',
      authorization: 'Bearer evil',
      'x-forwarded-for': '6.6.6.6',
      'x-forwarded-host': 'evil.example',
      'x-real-ip': '6.6.6.6',
      'cf-connecting-ip': '6.6.6.6',
      forwarded: 'for=6.6.6.6',
      'x-custom': 'kept',
    });
    expect(res.status).toBe(200);
    const h = seen[0]?.headers ?? {};
    expect(h['x-meshauth']).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h['x-forwarded-host']).toBeUndefined();
    expect(h['x-real-ip']).toBeUndefined();
    expect(h['cf-connecting-ip']).toBeUndefined();
    expect(h.forwarded).toBeUndefined();
    expect(h.cookie).toBe('xid=upstream-jar'); // brauzer cookie'si emas, sessiya jar'i
    expect(JSON.stringify(h)).not.toContain(c);
    expect(h['x-forwarded-for']).toBe('127.0.0.1');
    expect(h.host).toBe(new URL(`https://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`).host);
    expect(h['x-custom']).toBe('kept');
  });

  test('html responses are rewritten; rewrite failure returns 502', async () => {
    const c = await login(1);
    const s = sess(0);
    s.httpVerdict = { ok: true, upstreamPath: '/page' };
    s.rewrite = (url, html) => `${html.trim()}<!--rewritten ${url.pathname}-->`;
    const ok = await call('/doc', cookie(c));
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('<p>hello</p><!--rewritten /doc-->');
    expect(ok.headers['content-length']).toBe(String(Buffer.byteLength(ok.body)));

    s.rewrite = () => {
      throw new Error('malformed page');
    };
    const bad = await call('/doc', cookie(c));
    expect(bad.status).toBe(502);
    expect(bad.body).not.toContain('hello');
    expect(bad.body).not.toContain('malformed');
    expect(events).toContainEqual({ type: 'upstream_error', sessionId: 'rs-1', message: 'malformed page' });
  });

  test('requestHeaders failure returns 502 and emits upstream_error', async () => {
    const c = await login(1);
    sess(0).headersError = new Error('not attached');
    expect((await call('/x', cookie(c))).status).toBe(502);
    expect(seen).toEqual([]);
    expect(events).toContainEqual({ type: 'upstream_error', sessionId: 'rs-1', message: 'not attached' });
  });

  test('request on a closed session gets 401 and never goes upstream anonymously', async () => {
    const c = await login(1);
    await broker.close('rs-1');
    expect((await call('/x', cookie(c))).status).toBe(401);
    expect(seen).toEqual([]);
  });

  test('unreachable upstream returns 502', async () => {
    const c = await login(1);
    await new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      upstreamServer.close(() => r());
    });
    const res = await call('/x', cookie(c));
    expect(res.status).toBe(502);
    expect(events.some((e) => e.type === 'upstream_error')).toBe(true);
    upstreamServer = createHttps({ key: cert.key, cert: cert.cert }); // afterEach uchun
  });
});

// Xom TLS soket: Node http klienti noqonuniy so'rovni yubormaydi.
function raw(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: cert.cert }, () =>
      sock.write(payload),
    );
    let data = '';
    sock.on('data', (c) => {
      data += c.toString('utf8');
    });
    sock.on('end', () => resolve(data));
    sock.on('close', () => resolve(data));
    sock.on('error', reject);
  });
}

describe('gateway HTTP: request bodies', () => {
  test('request with a body is rejected and never reaches upstream', async () => {
    const c = await login(1);
    const smuggled = 'GET /admin HTTP/1.1\r\nHost: up\r\nX-Forwarded-For: 6.6.6.6\r\n\r\n';
    const head = (extra: string) =>
      `GET /x HTTP/1.1\r\nHost: localhost\r\nCookie: ${GATEWAY_COOKIE}=${c}\r\nConnection: close\r\n${extra}\r\n`;

    const chunked = await raw(
      `${head('Transfer-Encoding: chunked\r\n')}${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`,
    );
    expect(chunked).toMatch(/^HTTP\/1\.1 400 /);

    const withLength = await raw(`${head('Content-Length: 5\r\n')}hello`);
    expect(withLength).toMatch(/^HTTP\/1\.1 400 /);

    expect(seen).toEqual([]);
    expect(fake.sessions[0]?.routedHttp).toEqual([]);
  });

  test('content-length 0 and bodyless requests are still proxied', async () => {
    const c = await login(1);
    const res = await raw(
      `GET /x HTTP/1.1\r\nHost: localhost\r\nCookie: ${GATEWAY_COOKIE}=${c}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
    expect(res).toMatch(/^HTTP\/1\.1 200 /);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers['transfer-encoding']).toBeUndefined();
  });
});

describe('gateway HTTP: upstream timeout', () => {
  beforeEach(async () => {
    await gateway.close();
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    await start({ upstreamTimeoutMs: 200 });
  });

  test('hung upstream times out with 504', async () => {
    const c = await login(1);
    sess(0).httpVerdict = { ok: true, upstreamPath: '/hang' };
    const started = Date.now();
    const res = await call('/x', cookie(c));
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.body).not.toContain('hang');
    expect(events.filter((e) => e.type === 'upstream_error')).toHaveLength(1);
  });
});

describe('gateway HTTP: entry page', () => {
  test.each(['/plain', '/notype'])('entry page is rewritten even without text/html content-type (%s)', async (path) => {
    const c = await login(1);
    const s = sess(0);
    s.httpVerdict = { ok: true, upstreamPath: path };
    s.rewrite = (_url, html) => html.replace('entry-secret', 'scrubbed');
    const res = await call('/fake', cookie(c));
    expect(res.status).toBe(200);
    expect(res.body).toBe('scrubbed');
    expect(res.headers['content-length']).toBe('8');
  });

  test('entry page rewrite failure returns 502 instead of leaking the body', async () => {
    const c = await login(1);
    const s = sess(0);
    s.httpVerdict = { ok: true, upstreamPath: '/plain' };
    s.rewrite = () => {
      throw new Error('bad page');
    };
    const res = await call('/fake', cookie(c));
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('entry-secret');
  });

  test('HEAD on the entry path does not forward the upstream content-length', async () => {
    const c = await login(1);
    sess(0).httpVerdict = { ok: true, upstreamPath: '/plain' };
    const res = await call('/fake', cookie(c), 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.body).toBe('');
  });

  test('non-entry non-html responses are not rewritten', async () => {
    const c = await login(1);
    const s = sess(0);
    s.httpVerdict = { ok: true, upstreamPath: '/plain' };
    s.rewrite = () => 'REWRITTEN';
    expect((await call('/other.js', cookie(c))).body).toBe('entry-secret');
  });

  test('proxied responses carry nosniff', async () => {
    const c = await login(1);
    const s = sess(0);
    s.httpVerdict = { ok: true, upstreamPath: '/stream' };
    expect((await call('/a', cookie(c))).headers['x-content-type-options']).toBe('nosniff');
    s.httpVerdict = { ok: true, upstreamPath: '/page' };
    expect((await call('/b', cookie(c))).headers['x-content-type-options']).toBe('nosniff');
    s.httpVerdict = { ok: true, upstreamPath: '/plain' };
    expect((await call('/fake', cookie(c))).headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('gateway HTTP: html size cap', () => {
  beforeEach(async () => {
    await gateway.close();
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    await start({ maxHtmlBytes: 1024 });
  });

  test('oversized html returns 502', async () => {
    const c = await login(1);
    sess(0).httpVerdict = { ok: true, upstreamPath: '/big' };
    const res = await call('/doc', cookie(c));
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('xxxx');
    expect(events).toContainEqual(expect.objectContaining({ type: 'upstream_error', sessionId: 'rs-1' }));
  });

  test('html under the cap is served', async () => {
    const c = await login(1);
    sess(0).httpVerdict = { ok: true, upstreamPath: '/page' };
    expect((await call('/doc', cookie(c))).status).toBe(200);
  });
});

describe('sanitizeRequestHeaders', () => {
  test('drops credentials, forwarding and hop-by-hop headers and keeps the rest', () => {
    const out = sanitizeRequestHeaders({
      host: 'gw',
      cookie: 'a=b',
      authorization: 'x',
      'x-meshauth': 'x',
      forwarded: 'for=1',
      'x-forwarded-for': '1',
      'X-Forwarded-Proto': 'http',
      'x-real-ip': '1',
      'cf-connecting-ip': '1',
      connection: 'keep-alive, x-private',
      'x-private': '1',
      upgrade: 'websocket',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      accept: 'text/html',
      'x-multi': ['a', 'b'],
    });
    expect(out).toEqual({ accept: 'text/html', 'x-multi': 'a, b' });
  });
});
