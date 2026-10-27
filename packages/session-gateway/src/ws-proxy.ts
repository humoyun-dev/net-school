import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { type RawData, WebSocketServer } from 'ws';
import { sanitizeRequestHeaders } from './headers.ts';
import type { GatewaySession } from './registry.ts';
import type { GatewayEvent } from './types.ts';

const MAX_PAYLOAD = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024; // upstream ochilguncha navbatdagi brauzer kadrlari
const BROWSER_CLOSE_GRACE_MS = 1_000;

const CLOSE_NORMAL = 1000;
const CLOSE_TOO_BIG = 1009;
const CLOSE_POLICY = 1008;
const CLOSE_INTERNAL = 1011;
const HARD_CAP_FACTOR = 4;

type Channel = 'control' | 'relay';
type Direction = 'up' | 'down';

const CHANNELS: Record<string, Channel> = { '/control.ashx': 'control', '/meshrelay.ashx': 'relay' };

// ws klienti/serveri o'zi boshqaradigan handshake headerlari upstream'ga ko'chirilmaydi.
const HANDSHAKE_HEADERS = ['host', 'origin', 'connection', 'upgrade', 'content-length', 'transfer-encoding'];

export interface WsProxyOptions {
  publicOrigin: string;
  upstream: { origin: string; ca: string | Buffer; servername?: string };
  upstreamTimeoutMs: number;
  highWaterMark: number; // manzil bufferi shundan oshsa manba pauza qilinadi
  emit: (e: GatewayEvent) => void;
}

export interface WsProxy {
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, session: GatewaySession): void;
  closeAll(): void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Yaroqli close kodi (RFC 6455 7.4): 1005/1006/1015 va noma'lum diapazonlar yuborilmaydi.
function validCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)
  );
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

// Rad etilgan upgrade: minimal HTTP javob xom soketga yoziladi, so'ng soket yo'q qilinadi.
export function rejectUpgrade(socket: Duplex, status: number): void {
  socket.on('error', () => {});
  if (socket.destroyed) return;
  const head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`;
  socket.end(head, () => socket.destroy());
  setTimeout(() => socket.destroy(), 1_000).unref(); // yozish tiqilib qolsa ham soket qolib ketmaydi
}

const asBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

export function createWsProxy(opts: WsProxyOptions): WsProxy {
  const { emit } = opts;
  const upstreamBase = new URL(opts.upstream.origin);
  const upstreamWsOrigin = `${upstreamBase.protocol === 'https:' ? 'wss:' : 'ws:'}//${upstreamBase.host}`;
  const browserServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const active = new Set<{ close(code?: number): void }>(); // gateway.close() uchun

  function proxyPair(
    browser: WebSocket,
    session: GatewaySession,
    channel: Channel,
    upstreamPath: string,
    headers: Record<string, string>,
  ): void {
    let finished = false; // brauzer tomoni yopildi
    let closing = false; // gateway o'zi yopmoqda: upstream.terminate() xatosi upstream_error emas
    let graceTimer: NodeJS.Timeout | undefined;
    let queuedBytes = 0;
    const queue: Array<{ data: Buffer; isBinary: boolean }> = [];

    const upstream = new WebSocket(`${upstreamWsOrigin}${upstreamPath}`, {
      ca: opts.upstream.ca,
      ...(opts.upstream.servername ? { servername: opts.upstream.servername } : {}),
      headers,
      origin: opts.upstream.origin,
      maxPayload: MAX_PAYLOAD,
      handshakeTimeout: opts.upstreamTimeoutMs,
      perMessageDeflate: false,
    });

    // Brauzerga close kadri; javob kelmasa 1 s dan keyin soket uziladi.
    const closeBrowser = (code: number): void => {
      if (browser.readyState === WebSocket.OPEN) {
        try {
          browser.close(code);
        } catch {
          browser.terminate();
        }
      }
      if (browser.readyState !== WebSocket.CLOSED && graceTimer === undefined) {
        graceTimer = setTimeout(() => browser.terminate(), BROWSER_CLOSE_GRACE_MS);
      }
    };
    // Upstream close tasdig'i kutilmaydi: haqiqiy MeshCentral relay'lari uni juda kech beradi.
    const closeBoth = (code: number): void => {
      closing = true;
      closeBrowser(code);
      upstream.terminate();
    };

    const handle = {
      close(code?: number): void {
        closeBoth(code ?? CLOSE_NORMAL);
      },
    };
    session.sockets.add(handle);
    active.add(handle);

    // Kadr filtri: istisno ham tashlash (filter_error) va ulanishni yopish.
    const filter = (direction: Direction, data: Buffer, isBinary: boolean): string | Buffer | undefined => {
      try {
        const verdict = session.upstream.filterFrame(channel, direction, isBinary ? data : data.toString(), isBinary);
        if (verdict.ok) return verdict.data;
        emit({ type: 'frame_dropped', sessionId: session.id, channel, direction, reason: verdict.reason });
      } catch {
        emit({ type: 'frame_dropped', sessionId: session.id, channel, direction, reason: 'filter_error' });
        closeBoth(CLOSE_INTERNAL);
      }
      return undefined;
    };
    // Backpressure: manzil sekin bo'lsa manba pauza qilinadi, yuborish tugaganda davom ettiriladi;
    // pauza yetmasa (4x chegara) juft yopiladi: xotira hech qachon cheksiz o'smaydi.
    const send = (src: WebSocket, dst: WebSocket, data: string | Buffer, isBinary: boolean): void => {
      if (dst.readyState !== WebSocket.OPEN) return;
      const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      if (dst.bufferedAmount + size > opts.highWaterMark * HARD_CAP_FACTOR) {
        emit({ type: 'upstream_error', sessionId: session.id, message: 'backpressure' });
        closeBoth(CLOSE_POLICY); // kadr yuborilmaydi
        return;
      }
      dst.send(data, { binary: isBinary }, (err) => {
        if (err) return closeBoth(CLOSE_INTERNAL);
        if (src.isPaused && dst.bufferedAmount < opts.highWaterMark / 2) src.resume();
      });
      if (dst.bufferedAmount > opts.highWaterMark && !src.isPaused) src.pause();
    };
    const forwardUp = (data: Buffer, isBinary: boolean): void => {
      const out = filter('up', data, isBinary);
      if (out !== undefined) send(browser, upstream, out, isBinary);
    };

    browser.on('message', (raw, isBinary) => {
      const data = asBuffer(raw);
      if (upstream.readyState === WebSocket.OPEN) return forwardUp(data, isBinary);
      if (upstream.readyState !== WebSocket.CONNECTING) return;
      queuedBytes += data.length;
      if (queuedBytes > MAX_QUEUED_BYTES) {
        queue.length = 0;
        closeBoth(CLOSE_TOO_BIG);
        return;
      }
      queue.push({ data, isBinary });
    });
    browser.on('error', () => closeBoth(CLOSE_INTERNAL));
    browser.on('close', () => {
      finished = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      queue.length = 0;
      session.sockets.delete(handle);
      active.delete(handle);
      upstream.terminate();
    });

    upstream.on('open', () => {
      if (finished || session.closed) {
        closeBoth(CLOSE_POLICY);
        return;
      }
      for (const frame of queue.splice(0)) {
        if (upstream.readyState !== WebSocket.OPEN) break;
        forwardUp(frame.data, frame.isBinary);
      }
    });
    upstream.on('message', (raw, isBinary) => {
      const out = filter('down', asBuffer(raw), isBinary);
      if (out !== undefined) send(upstream, browser, out, isBinary);
    });
    upstream.on('error', (err) => {
      if (finished || closing) return; // o'zimiz terminate() qilgan: xato kutilgan
      emit({ type: 'upstream_error', sessionId: session.id, message: err.message });
      closeBoth(CLOSE_INTERNAL);
    });
    upstream.on('close', (code) => {
      closeBrowser(validCloseCode(code) ? code : CLOSE_NORMAL);
    });
  }

  return {
    upgrade(req, socket, head, url, session) {
      const channel = CHANNELS[url.pathname];
      // Origin aynan gateway origin'i bo'lishi shart (cross-site WebSocket hijacking'ga qarshi).
      if (req.headers.origin !== opts.publicOrigin) return rejectUpgrade(socket, 403);
      if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return rejectUpgrade(socket, 400);
      const clientIp = req.socket.remoteAddress;
      if (!clientIp) return rejectUpgrade(socket, 400);

      // Avval marshrut: yopiq sessiyaning requestHeaders()i bo'sh, so'rov anonim ketib qolmasin.
      const verdict = session.upstream.routeWs(url);
      if (!verdict.ok) {
        emit({ type: 'route_denied', sessionId: session.id, kind: 'ws', path: url.pathname, reason: verdict.reason });
        return rejectUpgrade(socket, 403);
      }
      if (!channel || !/^\/(?![/\\])/.test(verdict.upstreamPath)) {
        emit({
          type: 'route_denied',
          sessionId: session.id,
          kind: 'ws',
          path: url.pathname,
          reason: 'unknown_channel',
        });
        return rejectUpgrade(socket, 403);
      }

      const headers: Record<string, string> = { ...sanitizeRequestHeaders(req.headers) };
      try {
        for (const [name, value] of Object.entries(session.upstream.requestHeaders())) {
          headers[name.toLowerCase()] = value;
        }
      } catch (err) {
        emit({ type: 'upstream_error', sessionId: session.id, message: messageOf(err) });
        return rejectUpgrade(socket, 502);
      }
      for (const name of Object.keys(headers)) {
        if (HANDSHAKE_HEADERS.includes(name) || name.startsWith('sec-websocket-')) delete headers[name];
      }
      headers['x-forwarded-for'] = clientIp; // faqat gateway soketidan

      browserServer.handleUpgrade(req, socket, head, (browser) => {
        if (session.closed) {
          browser.close(1008);
          setTimeout(() => browser.terminate(), BROWSER_CLOSE_GRACE_MS).unref();
          return;
        }
        proxyPair(browser, session, channel, verdict.upstreamPath, headers);
      });
    },
    closeAll() {
      for (const handle of [...active]) handle.close(1001);
      for (const client of browserServer.clients) client.terminate();
    },
  };
}
