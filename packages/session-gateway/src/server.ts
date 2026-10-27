import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import type { RemoteSessionBroker } from './broker.ts';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './headers.ts';
import type { GatewaySession, SessionRegistry } from './registry.ts';
import type { TicketStore } from './tickets.ts';
import type { GatewayEvent } from './types.ts';
import { createWsProxy, rejectUpgrade } from './ws-proxy.ts';

export const GATEWAY_COOKIE = '__Host-ns_rs';

const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export interface GatewayOptions {
  tls: { key: string; cert: string };
  upstream: { origin: string; ca: string | Buffer; servername?: string };
  broker: RemoteSessionBroker;
  tickets: TicketStore;
  registry: SessionRegistry;
  publicOrigin: string; // brauzer ko'radigan origin; WS Origin tekshiruvi shunga teng bo'lishi shart
  maxHtmlBytes?: number;
  upstreamTimeoutMs?: number; // upstream soketi shuncha jim tursa 504 (default 30 s)
  onEvent?: (e: GatewayEvent) => void;
}

export interface Gateway {
  server: https.Server;
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// So'rov nishoni aynan bitta '/' bilan boshlanuvchi yo'l bo'lishi shart: '//host', '/\\host' va
// absolyut shakl URL'ni boshqa hostga burib yuboradi.
function parseTarget(target: string | undefined, publicOrigin: string): URL | undefined {
  if (!target || !/^\/(?![/\\])/.test(target)) return undefined;
  try {
    const url = new URL(target, publicOrigin);
    return url.origin === new URL(publicOrigin).origin ? url : undefined;
  } catch {
    return undefined;
  }
}

// Ichki xato matni va upstream tafsilotlari brauzerga chiqmaydi.
function reply(res: ServerResponse, status: number, text: string, closeConnection = false): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(`${text}\n`);
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...(closeConnection ? { connection: 'close' } : {}),
  });
  res.end(body);
}

export function createGateway(opts: GatewayOptions): Gateway {
  const { tickets, registry, onEvent } = opts;
  const maxHtmlBytes = opts.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const upstreamUrl = new URL(opts.upstream.origin);
  const agent = new https.Agent({
    ca: opts.upstream.ca,
    ...(opts.upstream.servername ? { servername: opts.upstream.servername } : {}),
    keepAlive: true,
  });

  // Tinglovchi xatosi so'rovni buzmasin.
  const emit = (e: GatewayEvent): void => {
    try {
      onEvent?.(e);
    } catch {
      // hodisa tinglovchisi xatosi gateway holatiga ta'sir qilmaydi
    }
  };

  const supersede = (old: GatewaySession): void => {
    if (registry.get(old.id)?.closed !== false) return;
    const closing = registry.close(old.id, 'superseded');
    emit({ type: 'session_closed', sessionId: old.id, reason: 'superseded' });
    // Yangi sessiya yo'naltirishi eskisining revoke'ini kutmaydi.
    closing.catch((err: unknown) => emit({ type: 'upstream_error', sessionId: old.id, message: messageOf(err) }));
  };

  async function redeem(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const redeemed = tickets.redeem(url.searchParams.get('ticket') ?? '');
    if ('error' in redeemed) {
      emit({ type: 'ticket_rejected', reason: redeemed.error });
      return reply(res, 403, 'Forbidden');
    }
    const session = registry.get(redeemed.sessionId);
    // Yopilgan sessiyaning ticketi muddati tugamaguncha redeem bo'ladi: sessiya yaratilmaydi.
    if (!session || session.closed) return reply(res, 403, 'Forbidden');
    const clientIp = req.socket.remoteAddress;
    if (!clientIp) return reply(res, 400, 'Bad Request');

    try {
      await session.upstream.attach(clientIp);
    } catch (err) {
      if (session.closed) return reply(res, 403, 'Forbidden'); // attach yopilish sababli yiqildi
      emit({ type: 'upstream_error', sessionId: session.id, message: messageOf(err) });
      registry.close(session.id, 'revoked').catch((closeErr: unknown) => {
        emit({ type: 'upstream_error', sessionId: session.id, message: messageOf(closeErr) });
      });
      return reply(res, 502, 'Bad Gateway');
    }

    let cookieValue: string;
    try {
      cookieValue = registry.bindCookie(session.id);
    } catch {
      return reply(res, 403, 'Forbidden'); // attach paytida sessiya yopilgan
    }

    // Brauzerda boshqa ochiq sessiya cookie'si bo'lsa, u almashtiriladi.
    const old = registry.byCookie(readCookie(req.headers.cookie, GATEWAY_COOKIE));
    if (old && old.id !== session.id) supersede(old);

    res.writeHead(303, {
      location: session.upstream.entryPath,
      'set-cookie': `${GATEWAY_COOKIE}=${cookieValue}; HttpOnly; Secure; SameSite=Strict; Path=/`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end();
  }

  function proxy(req: IncomingMessage, res: ServerResponse, url: URL, session: GatewaySession): void {
    let failedOnce = false;
    const fail = (message: string, status = 502): void => {
      if (failedOnce) return;
      failedOnce = true;
      emit({ type: 'upstream_error', sessionId: session.id, message });
      reply(res, status, status === 504 ? 'Gateway Timeout' : 'Bad Gateway');
    };
    const clientIp = req.socket.remoteAddress;
    if (!clientIp) {
      reply(res, 400, 'Bad Request');
      return;
    }

    // Upstream'ga hech qachon so'rov tanasi yuborilmaydi: aks holda tana keep-alive ulanishda
    // ikkinchi so'rov bo'lib o'qilib, routeHttp'dan o'tib ketadi (request smuggling).
    const contentLength = req.headers['content-length'];
    if (
      req.headers['transfer-encoding'] !== undefined ||
      (contentLength !== undefined && contentLength.trim() !== '0')
    ) {
      reply(res, 400, 'Bad Request', true);
      return;
    }

    // Avval marshrut tekshiruvi: yopiq sessiyaning requestHeaders()i bo'sh, so'rov anonim ketib qolmasin.
    const method = req.method ?? 'GET';
    const verdict = session.upstream.routeHttp(method, url);
    if (!verdict.ok) {
      emit({ type: 'route_denied', sessionId: session.id, kind: 'http', path: url.pathname, reason: verdict.reason });
      reply(res, 403, 'Forbidden');
      return;
    }

    const headers: Record<string, string> = { ...sanitizeRequestHeaders(req.headers) };
    try {
      for (const [name, value] of Object.entries(session.upstream.requestHeaders())) {
        headers[name.toLowerCase()] = value;
      }
    } catch (err) {
      fail(messageOf(err));
      return;
    }
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    headers.host = upstreamUrl.host;
    headers['x-forwarded-for'] = clientIp; // faqat gateway soketidan
    headers['accept-encoding'] = 'identity'; // HTML qayta yozish uchun siqilmagan tana kerak

    // Kirish sahifasi content-type'dan qat'i nazar qayta yoziladi (credential tozalash fail-open bo'lmasin).
    const isEntryPage =
      (method === 'GET' || method === 'HEAD') &&
      url.pathname === new URL(session.upstream.entryPath, opts.publicOrigin).pathname;

    const upReq = https.request(
      {
        agent,
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        method,
        path: verdict.upstreamPath,
        headers,
      },
      (upRes) => {
        const setCookie = upRes.headers['set-cookie'];
        if (setCookie?.length) {
          try {
            session.upstream.absorbSetCookie(setCookie);
          } catch (err) {
            upRes.destroy();
            return fail(messageOf(err));
          }
        }
        const status = upRes.statusCode ?? 502;
        const outHeaders = sanitizeResponseHeaders(upRes.headers);
        outHeaders['x-content-type-options'] = 'nosniff';
        const isHtml = String(upRes.headers['content-type'] ?? '')
          .trim()
          .toLowerCase()
          .startsWith('text/html');
        const hasBody = method !== 'HEAD' && status !== 204 && status !== 304;

        if (isEntryPage && !hasBody) delete outHeaders['content-length']; // HEAD: tana yo'q, upstream uzunligi yo'naltirilmaydi
        if (!((isHtml || isEntryPage) && hasBody)) {
          res.writeHead(status, outHeaders);
          pipeline(upRes, res, (err) => {
            if (err) res.destroy();
          });
          return;
        }

        // HTML: to'liq yig'iladi, qayta yoziladi, content-length qayta hisoblanadi.
        if (upRes.headers['content-encoding'] && upRes.headers['content-encoding'] !== 'identity') {
          upRes.destroy();
          return fail('Upstream HTML is encoded');
        }
        const declared = Number(upRes.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxHtmlBytes) {
          upRes.destroy();
          return fail('Upstream HTML exceeds the size limit');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let failed = false;
        upRes.on('data', (chunk: Buffer) => {
          if (failed) return;
          size += chunk.length;
          if (size > maxHtmlBytes) {
            failed = true;
            upRes.destroy();
            fail('Upstream HTML exceeds the size limit');
            return;
          }
          chunks.push(chunk);
        });
        upRes.on('error', (err) => {
          if (failed) return;
          failed = true;
          fail(err.message);
        });
        upRes.on('end', () => {
          if (failed) return;
          let body: Buffer;
          try {
            body = Buffer.from(session.upstream.rewriteHtml(url, Buffer.concat(chunks).toString('utf8')), 'utf8');
          } catch (err) {
            return fail(messageOf(err)); // xom upstream tanasi hech qachon yuborilmaydi
          }
          delete outHeaders['content-length'];
          res.writeHead(status, { ...outHeaders, 'content-length': String(body.length) });
          res.end(body);
        });
      },
    );
    upReq.on('error', (err) => fail(err.message));
    upReq.setTimeout(upstreamTimeoutMs, () => {
      fail('Upstream timed out', 504); // javob boshlangan bo'lsa brauzer javobi uziladi
      upReq.destroy();
    });
    // Brauzer uzilsa upstream so'rovi ham to'xtaydi.
    res.on('close', () => {
      if (!res.writableFinished) upReq.destroy();
    });
    req.resume();
    upReq.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = parseTarget(req.url, opts.publicOrigin);
    if (!url) return reply(res, 400, 'Bad Request', true);
    if (req.method === 'GET' && url.pathname === '/rs/redeem') return redeem(req, res, url);

    const session = registry.byCookie(readCookie(req.headers.cookie, GATEWAY_COOKIE));
    if (!session) return reply(res, 401, 'Unauthorized');
    proxy(req, res, url, session);
  }

  const server = https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, (req, res) => {
    handle(req, res).catch(() => reply(res, 500, 'Internal Server Error'));
  });

  const wsProxy = createWsProxy({
    publicOrigin: opts.publicOrigin,
    upstream: opts.upstream,
    upstreamTimeoutMs,
    emit,
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {}); // upgrade'dan keyin http xato tinglovchisi yo'q
    try {
      const url = parseTarget(req.url, opts.publicOrigin);
      if (!url) return rejectUpgrade(socket, 400);
      const session = registry.byCookie(readCookie(req.headers.cookie, GATEWAY_COOKIE));
      if (!session) return rejectUpgrade(socket, 401);
      wsProxy.upgrade(req, socket, head, url, session);
    } catch {
      rejectUpgrade(socket, 500);
    }
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
        wsProxy.closeAll(); // upgrade qilingan soketlar http ro'yxatida emas
        agent.destroy();
      }),
  };
}
