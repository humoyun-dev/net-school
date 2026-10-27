import { createHash, createPublicKey } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { request } from 'node:https';
import type { AuthorizedDesktopRequest, UpstreamDeviceRef } from '@netschool/domain';
import {
  MeshCentralDeviceManagement,
  type MeshCentralViewerSession,
  MeshCentralViewerUpstream,
  MeshControlClient,
  type MeshRequester,
  type SiteMeshScope,
  type UpstreamEndpoint,
} from '@netschool/meshcentral-adapter';
import {
  createGateway,
  type Gateway,
  type GatewayEvent,
  RemoteSessionBroker,
  SessionRegistry,
  TicketStore,
  type UpstreamViewerSession,
  type ViewerUpstream,
} from '@netschool/session-gateway';
import { makeCert } from '@netschool/test-support';
import WebSocket from 'ws';
import { freePort, type MeshCentralInstance } from './meshcentral.ts';

const scope: SiteMeshScope = { meshInstanceId: 'mc-test', meshDomainId: '' };
const GATEWAY_COOKIE = '__Host-ns_rs';

export interface HttpReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

// Brauzer o'rni: gateway sertifikati CA sifatida beriladi (TLS tekshiruvi o'chirilmaydi), cookie qo'lda saqlanadi.
export class Browser {
  readonly redeemSetCookie: string[] = [];
  readonly redeemHeaders: string[] = [];
  #cookie: string | undefined;
  readonly #port: number;
  readonly #ca: string;

  constructor(port: number, ca: string) {
    this.#port = port;
    this.#ca = ca;
  }

  cookieHeader(): string {
    return this.#cookie ? `${GATEWAY_COOKIE}=${this.#cookie}` : '';
  }

  get(path: string, opts: { cookie?: boolean } = {}): Promise<HttpReply> {
    const headers: Record<string, string> = { host: `localhost:${this.#port}` };
    if (opts.cookie !== false && this.#cookie) headers.cookie = this.cookieHeader();
    return new Promise((resolve, reject) => {
      request(
        { host: '127.0.0.1', port: this.#port, servername: 'localhost', ca: this.#ca, path, method: 'GET', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      )
        .on('error', reject)
        .end();
    });
  }

  async redeem(ticket: string): Promise<HttpReply> {
    const reply = await this.get(`/rs/redeem?ticket=${encodeURIComponent(ticket)}`, { cookie: false });
    this.redeemHeaders.push(JSON.stringify(reply.headers), reply.body);
    const setCookie = reply.headers['set-cookie'] ?? [];
    this.redeemSetCookie.push(...setCookie);
    for (const line of setCookie) {
      const pair = line.split(';')[0] ?? '';
      if (pair.startsWith(`${GATEWAY_COOKIE}=`)) this.#cookie = pair.slice(GATEWAY_COOKIE.length + 1);
    }
    return reply;
  }

  // Upgrade'da Origin = publicOrigin; cookie `cookie: false` bo'lmasa avtomatik qo'shiladi.
  socket(path: string, opts: { cookie?: boolean } = {}): WebSocket {
    const headers: Record<string, string> = {};
    if (opts.cookie !== false && this.#cookie) headers.cookie = this.cookieHeader();
    const options: WebSocket.ClientOptions & { servername: string } = {
      ca: this.#ca,
      servername: 'localhost',
      origin: `https://localhost:${this.#port}`,
      headers: { ...headers, host: `localhost:${this.#port}` },
    };
    return new WebSocket(`wss://127.0.0.1:${this.#port}${path}`, options);
  }
}

export interface RealCredentials {
  username: string;
  password: string;
  upstreamCookies: string[]; // xid, xid.sig
  pageCookies: string[]; // kirish sahifasidagi real authCookie, authRelayCookie
  controlCookies: string[]; // authcookie javobidagi real cookie, rcookie
}

// Gateway ko'radigan sessiya: real qiymatlar faqat sinov solishtirishi uchun yozib olinadi.
class RecordingSession implements UpstreamViewerSession {
  readonly rawPages: string[] = [];
  readonly rawControlDown: string[] = [];
  upstreamCookieHeader = '';
  readonly #inner: MeshCentralViewerSession;
  readonly username: string;
  readonly password: string;

  constructor(inner: MeshCentralViewerSession, creds: { username: string; password: string }) {
    this.#inner = inner;
    this.username = creds.username;
    this.password = creds.password;
  }

  get entryPath(): string {
    return this.#inner.entryPath;
  }

  async attach(clientIp: string): Promise<void> {
    await this.#inner.attach(clientIp);
    this.upstreamCookieHeader = this.#inner.requestHeaders().cookie ?? '';
  }

  routeHttp: UpstreamViewerSession['routeHttp'] = (method, url) => this.#inner.routeHttp(method, url);
  // control.ashx ulanishining pastga kadrlari (real cookie'lar) solishtirish uchun yozib olinadi.
  routeWs: UpstreamViewerSession['routeWs'] = (url) => {
    const verdict = this.#inner.routeWs(url);
    if (!verdict.ok || url.pathname !== '/control.ashx') return verdict;
    const inner = verdict.filter;
    return {
      ...verdict,
      filter: (direction, data, isBinary) => {
        if (direction === 'down' && !isBinary) this.rawControlDown.push(data.toString());
        return inner(direction, data, isBinary);
      },
    };
  };
  requestHeaders: UpstreamViewerSession['requestHeaders'] = () => this.#inner.requestHeaders();
  absorbSetCookie: UpstreamViewerSession['absorbSetCookie'] = (values) => this.#inner.absorbSetCookie(values);

  rewriteHtml(url: URL, html: string): string {
    if (url.pathname === '/') this.rawPages.push(html);
    return this.#inner.rewriteHtml(url, html);
  }

  revoke(): Promise<void> {
    return this.#inner.revoke();
  }
}

export interface GatewayStack {
  gatewayOrigin: string;
  ca: string;
  spki: string; // gateway sertifikati public key'ining SHA-256 base64 qiymati (Chromium SPKI pin)
  broker: RemoteSessionBroker;
  registry: SessionRegistry;
  events: GatewayEvent[];
  admin: MeshControlClient;
  upstreamEndpoint: UpstreamEndpoint;
  device(name: string): Promise<UpstreamDeviceRef>;
  nodeIdOf(device: UpstreamDeviceRef): string;
  browser(): Browser;
  directSocket(path: string, headers: Record<string, string>): WebSocket; // gateway'siz, MeshCentral'ga bevosita
  credentialsOf(sessionId: string): RealCredentials;
  stop(): Promise<void>;
}

const cookieValues = (header: string, names: string[]): string[] =>
  header
    .split(';')
    .map((part) => part.trim())
    .flatMap((part) => {
      const eq = part.indexOf('=');
      return eq > 0 && names.includes(part.slice(0, eq)) ? [part.slice(eq + 1)] : [];
    });

// Chromium `--ignore-certificate-errors-spki-list` uchun: faqat shu public key'ga ishonadi.
export function spkiSha256Base64(certPem: string): string {
  const der = createPublicKey(certPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

export async function startGatewayStack(
  mc: MeshCentralInstance,
  opts: { now?: () => number } = {},
): Promise<GatewayStack> {
  const mcUrl = new URL(mc.url);
  const upstreamEndpoint: UpstreamEndpoint = { origin: `https://${mcUrl.hostname}:${mcUrl.port}`, ca: mc.ca };

  const admin = new MeshControlClient({
    url: mc.url,
    ca: mc.ca,
    username: mc.admin.username,
    password: mc.admin.password,
  });
  await admin.connect();
  const meshid = (await admin.request<{ meshid: string }>('createmesh', { meshname: 'contract', meshtype: 3 })).meshid;
  for (const name of ['pc-01', 'pc-02']) {
    await admin.request('addlocaldevice', { meshid, devicename: name, hostname: `${name}.lan`, type: 4 });
  }
  const management = new MeshCentralDeviceManagement(admin, new Map([['site-a', scope]]));

  // adduser so'rovlaridan principal login/parolini ushlaydi.
  const created: { username: string; password: string }[] = [];
  const spy: MeshRequester = {
    request: (async (action: string, payload?: Record<string, unknown>) => {
      if (action === 'adduser' && payload) {
        created.push({ username: String(payload.username), password: String(payload.pass) });
      }
      return admin.request(action, payload);
    }) as MeshRequester['request'],
    onMessage: (h) => admin.onMessage(h),
    onResync: (h) => admin.onResync(h),
  };

  const port = await freePort();
  const publicHost = `localhost:${port}`;
  const gatewayOrigin = `https://${publicHost}`;
  const tls = await makeCert('localhost');
  const events: GatewayEvent[] = [];
  const onEvent = (e: GatewayEvent) => {
    events.push(e);
  };

  const viewerUpstream = new MeshCentralViewerUpstream({ admin: spy, endpoint: upstreamEndpoint, publicHost });
  const recorded = new Map<string, RecordingSession>();
  const upstream: ViewerUpstream = {
    async open(req: AuthorizedDesktopRequest) {
      const before = created.length;
      const inner = await viewerUpstream.open(req);
      const creds = created[before];
      if (!creds || created.length !== before + 1) throw new Error('principal credentials were not captured');
      const session = new RecordingSession(inner, creds);
      recorded.set(req.sessionId, session);
      return session;
    },
  };

  const tickets = new TicketStore(opts.now ? { now: opts.now } : {});
  const registry = new SessionRegistry();
  const broker = new RemoteSessionBroker({ upstream, tickets, registry, onEvent });
  const gateway: Gateway = createGateway({
    tls,
    upstream: upstreamEndpoint,
    publicOrigin: gatewayOrigin,
    broker,
    tickets,
    registry,
    onEvent,
  });
  await gateway.listen(port, '127.0.0.1');

  const recordedOf = (sessionId: string): RecordingSession => {
    const session = recorded.get(sessionId);
    if (!session) throw new Error(`session not recorded: ${sessionId}`);
    return session;
  };

  return {
    gatewayOrigin,
    ca: tls.cert,
    spki: spkiSha256Base64(tls.cert),
    broker,
    registry,
    events,
    admin,
    upstreamEndpoint,
    async device(name) {
      const found = (await management.listDevices('site-a')).find((d) => d.name === name);
      if (!found) throw new Error(`${name} not found`);
      return found.upstream;
    },
    nodeIdOf: (d) => `node/${d.meshDomainId}/${d.meshNodeId}`,
    browser: () => new Browser(port, tls.cert),
    directSocket(path, headers) {
      const options: WebSocket.ClientOptions & { servername: string } = {
        ca: mc.ca,
        servername: mcUrl.hostname,
        headers,
      };
      return new WebSocket(`wss://${mcUrl.hostname}:${mcUrl.port}${path}`, options);
    },
    credentialsOf(sessionId) {
      const session = recordedOf(sessionId);
      const page = session.rawPages.at(-1) ?? '';
      const pick = (name: string) => new RegExp(`var ${name} = '([^']+)';`).exec(page)?.[1];
      const control = session.rawControlDown.flatMap((raw) => {
        try {
          const frame = JSON.parse(raw) as Record<string, unknown>;
          return frame.action === 'authcookie' ? [frame.cookie, frame.rcookie] : [];
        } catch {
          return [];
        }
      });
      return {
        username: session.username,
        password: session.password,
        upstreamCookies: cookieValues(session.upstreamCookieHeader, ['xid', 'xid.sig']),
        pageCookies: [pick('authCookie'), pick('authRelayCookie')].filter((v): v is string => v !== undefined),
        controlCookies: control.filter((v): v is string => typeof v === 'string' && v !== ''),
      };
    },
    async stop() {
      await gateway.close();
      await admin.close();
    },
  };
}
