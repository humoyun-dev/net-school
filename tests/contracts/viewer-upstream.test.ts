import { get } from 'node:https';
import type { AuthorizedDesktopRequest, UpstreamDeviceRef } from '@netschool/domain';
import {
  AdapterError,
  loginPrincipal,
  MeshCentralDeviceManagement,
  type MeshCentralViewerSession,
  MeshCentralViewerUpstream,
  MeshControlClient,
  type MeshRequester,
  type SiteMeshScope,
  type UpstreamEndpoint,
} from '@netschool/meshcentral-adapter';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { type MeshCentralInstance, startMeshCentral } from './harness/meshcentral.ts';

const PUBLIC_HOST = 'gw.test:9443';
const CLIENT_IP = '10.20.30.40';
const scope: SiteMeshScope = { meshInstanceId: 'mc-test', meshDomainId: '' };
const site = new Map([['site-a', scope]]);

let mc: MeshCentralInstance;
let admin: MeshControlClient;
let endpoint: UpstreamEndpoint;
let upstream: MeshCentralViewerUpstream;
let pc01: UpstreamDeviceRef;
let hostname: string;
let port: string;
// adduser so'rovlaridan principal login/parolini ushlaydi (revoke'dan keyin qayta login sinovi uchun).
const created: { username: string; password: string }[] = [];
const sessions: MeshCentralViewerSession[] = [];

function spy(inner: MeshRequester): MeshRequester {
  return {
    request: (async (action: string, payload?: Record<string, unknown>) => {
      if (action === 'adduser' && payload) {
        created.push({ username: String(payload.username), password: String(payload.pass) });
      }
      return inner.request(action, payload);
    }) as MeshRequester['request'],
    onMessage: (h) => inner.onMessage(h),
    onResync: (h) => inner.onResync(h),
  };
}

async function open(mode: AuthorizedDesktopRequest['mode'] = 'view'): Promise<MeshCentralViewerSession> {
  const session = await upstream.open({ sessionId: 's-1', actorId: 'u-1', device: pc01, mode });
  sessions.push(session);
  return session;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof AdapterError ? err.code : `not-adapter-error: ${String(err)}`;
  }
  return 'resolved';
}

function fetchPage(session: MeshCentralViewerSession, path: string): Promise<{ status: number; html: string }> {
  return new Promise((resolve, reject) => {
    get(`${endpoint.origin}${path}`, { ca: endpoint.ca, headers: session.requestHeaders() }, (res) => {
      let html = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        html += chunk;
      });
      res.on('end', () => {
        session.absorbSetCookie(res.headers['set-cookie'] ?? []);
        resolve({ status: res.statusCode ?? 0, html });
      });
    }).on('error', reject);
  });
}

function wsUrl(upstreamPath: string): string {
  return `wss://${hostname}:${port}${upstreamPath}`;
}

function connect(upstreamPath: string, headers: Record<string, string>): WebSocket {
  const options: WebSocket.ClientOptions & { servername: string } = { ca: endpoint.ca, servername: hostname, headers };
  return new WebSocket(wsUrl(upstreamPath), options);
}

type Outcome = 'open' | 'closed' | 'rejected';

// Ulanish `ms` davomida ochiq qolsa 'open', yopilsa 'closed', upgrade rad etilsa 'rejected'.
// MeshCentral rad etilgan relay'ni close frame bilan yopadi, lekin soket pauzada qolgani uchun
// 'close' hodisasi ws'ning 30 s timeout'igacha kechikadi; shu sabab readyState (CLOSING) kuzatiladi.
function outcome(ws: WebSocket, ms: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let opened = false;
    let watch: NodeJS.Timeout | undefined;
    const finish = (result: Outcome) => {
      clearInterval(watch);
      resolve(result);
      ws.terminate();
    };
    ws.on('open', () => {
      opened = true;
      const deadline = Date.now() + ms;
      watch = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) finish('closed');
        else if (Date.now() >= deadline) finish('open');
      }, 20);
    });
    ws.on('error', () => {
      if (!opened) finish('rejected');
    });
    ws.on('close', () => finish(opened ? 'closed' : 'rejected'));
  });
}

function realAuthCookie(html: string): string {
  const real = /var authCookie = '([^']+)';/.exec(html)?.[1];
  if (!real) throw new Error('entry page has no authCookie');
  return real;
}

beforeAll(async () => {
  mc = await startMeshCentral();
  const url = new URL(mc.url);
  hostname = url.hostname;
  port = url.port;
  endpoint = { origin: `https://${hostname}:${port}`, ca: mc.ca };
  admin = new MeshControlClient({ url: mc.url, ca: mc.ca, username: mc.admin.username, password: mc.admin.password });
  await admin.connect();
  const meshid = (await admin.request<{ meshid: string }>('createmesh', { meshname: 'contract', meshtype: 3 })).meshid;
  for (const name of ['pc-01', 'pc-02']) {
    await admin.request('addlocaldevice', { meshid, devicename: name, hostname: `${name}.lan`, type: 4 });
  }
  const found = (await new MeshCentralDeviceManagement(admin, site).listDevices('site-a')).find(
    (d) => d.name === 'pc-01',
  );
  if (!found) throw new Error('pc-01 not found');
  pc01 = found.upstream;
  upstream = new MeshCentralViewerUpstream({ admin: spy(admin), endpoint, publicHost: PUBLIC_HOST });
});

afterAll(async () => {
  await Promise.all(sessions.map((s) => s.revoke().catch(() => {})));
  await admin?.close();
  await mc?.stop();
});

describe('MeshCentralViewerUpstream against pinned upstream', () => {
  test('login gives a session jar with xid and xid.sig', async () => {
    const session = await open();
    await session.attach(CLIENT_IP);
    const headers = session.requestHeaders();
    expect(headers['x-forwarded-for']).toBe(CLIENT_IP);
    expect(headers.cookie).toMatch(/(?:^|; )xid=[^;]+/);
    expect(headers.cookie).toMatch(/(?:^|; )xid\.sig=[^;]+/);
  });

  test('entry page through the session has no upstream credential', async () => {
    const session = await open();
    await session.attach(CLIENT_IP);
    const page = await fetchPage(session, session.entryPath);
    expect(page.status).toBe(200);
    const real = realAuthCookie(page.html);

    const rewritten = session.rewriteHtml(new URL(session.entryPath, `https://${PUBLIC_HOST}`), page.html);
    expect(rewritten).not.toContain(real);
    expect(rewritten).toContain(PUBLIC_HOST);
    expect(rewritten).toMatch(/var authCookie = 'nsh_[A-Za-z0-9_-]+';/);
    // Boshqa yo'llar o'zgarishsiz qaytadi.
    expect(session.rewriteHtml(new URL('/scripts/x.js', `https://${PUBLIC_HOST}`), page.html)).toBe(page.html);
  });

  test('real authCookie opens meshrelay directly but its handle does not', async () => {
    const session = await open();
    await session.attach(CLIENT_IP);
    const page = await fetchPage(session, session.entryPath);
    const real = realAuthCookie(page.html);
    const handle = /var authCookie = '(nsh_[^']+)';/.exec(
      session.rewriteHtml(new URL(session.entryPath, `https://${PUBLIC_HOST}`), page.html),
    )?.[1];
    expect(handle).toBeDefined();
    const nodeId = new URL(session.entryPath, `https://${PUBLIC_HOST}`).searchParams.get('gotonode') ?? '';
    const relay = (auth: string) =>
      `/meshrelay.ashx?browser=1&p=2&nodeid=${encodeURIComponent(nodeId)}&id=abc&auth=${encodeURIComponent(auth)}`;
    const xff = { 'x-forwarded-for': CLIENT_IP };

    // Ijobiy nazorat: real cookie bilan relay ochiladi, ya'ni bypass xavfi haqiqiy.
    expect(await outcome(connect(relay(real), xff), 1_000)).toBe('open');
    // Handle upstream uchun hech narsa emas.
    expect(await outcome(connect(relay(handle ?? ''), xff), 2_000)).not.toBe('open');

    // Gateway yo'li: handle policy orqali real qiymatga almashadi va relay ochiladi.
    const verdict = session.routeWs(
      new URL(
        `wss://${PUBLIC_HOST}/meshrelay.ashx?browser=1&p=2&nodeid=${encodeURIComponent(nodeId)}&id=abc&auth=${handle}`,
      ),
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(await outcome(connect(verdict.upstreamPath, session.requestHeaders()), 1_000)).toBe('open');
  });

  test('attach from a different client IP is denied', async () => {
    const session = await open();
    await session.attach(CLIENT_IP);
    await expect(session.attach(CLIENT_IP)).resolves.toBeUndefined();
    expect(await codeOf(session.attach('10.20.30.41'))).toBe('scope_denied');
  });

  test('revoke deletes the principal and its control sessions', async () => {
    const session = await open();
    await session.attach(CLIENT_IP);
    const credentials = created.at(-1);
    expect(credentials).toBeDefined();

    const verdict = session.routeWs(new URL(`wss://${PUBLIC_HOST}/control.ashx`));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const ws = connect(verdict.upstreamPath, session.requestHeaders());
    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve());
      ws.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    await session.revoke();
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('control.ashx stayed open')), 10_000)),
    ]);
    await expect(session.revoke()).resolves.toBeUndefined();

    expect(
      await codeOf(loginPrincipal(endpoint, credentials as { username: string; password: string }, CLIENT_IP)),
    ).toBe('upstream_auth_failed');
  });
});
