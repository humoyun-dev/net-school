import { randomUUID } from 'node:crypto';
import type { Unsubscribe } from '@netschool/domain';
import WebSocket from 'ws';
import { AdapterError, type AdapterErrorCode } from './errors.ts';

export interface MeshControlClientOptions {
  url: string;
  username: string;
  password: string;
  ca: string | Buffer; // majburiy; tizim CA'lari bilan almashtirilmaydi
  servername?: string; // default: URL hostname
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  reconnect?: { minDelayMs: number; maxDelayMs: number };
  connectTimeoutMs?: number; // TLS handshake + serverinfo kelguncha
  heartbeatIntervalMs?: number; // ping oralig'i; ikki oraliqda pong yo'q → ulanish o'lik
}

// correlate: 'tag' — `users` kabi action'lar muvaffaqiyatda responseid emas, `tag`ni qaytaradi (meshuser.js serverCommandUsers);
// shuning uchun ikkala kalit yuboriladi va qaysi biri bilan javob kelsa, shu so'rov tugaydi.
export interface MeshRequestOptions {
  correlate?: 'responseid' | 'tag';
}

export interface MeshRequester {
  request<T = Record<string, unknown>>(
    action: string,
    payload?: Record<string, unknown>,
    opts?: MeshRequestOptions,
  ): Promise<T>;
  onMessage(handler: (msg: unknown) => void): Unsubscribe;
  onResync(handler: () => void): Unsubscribe;
}

interface Pending {
  byTag: boolean;
  resolve(value: unknown): void;
  reject(err: AdapterError): void;
  timer: NodeJS.Timeout;
}

type Message = Record<string, unknown>;

const TLS_ERROR = /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/;

// control.ashx ustidan bitta persistent ulanish: responseid correlation, timeout, reconnect + resync.
// TLS tekshiruvi hech qachon o'chirilmaydi (rejectUnauthorized default true qoladi).
export class MeshControlClient implements MeshRequester {
  readonly #opts: Required<Omit<MeshControlClientOptions, 'servername'>> & { servername?: string };
  readonly #pending = new Map<string, Pending>();
  readonly #messageHandlers = new Set<(msg: unknown) => void>();
  readonly #resyncHandlers = new Set<() => void>();
  #ws: WebSocket | undefined;
  #ready = false;
  #closed = false;
  #fatal: AdapterError | undefined;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;

  constructor(opts: MeshControlClientOptions) {
    this.#opts = {
      requestTimeoutMs: 10_000,
      maxMessageBytes: 4 * 1024 * 1024,
      reconnect: { minDelayMs: 1_000, maxDelayMs: 30_000 },
      connectTimeoutMs: 15_000,
      heartbeatIntervalMs: 30_000,
      ...opts,
    };
  }

  connect(): Promise<void> {
    return this.#open();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#failPending('upstream_unavailable', 'Client closed');
    const ws = this.#ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((done) => {
      ws.once('close', () => done());
      ws.close();
    });
  }

  request<T = Message>(action: string, payload: Message = {}, opts: MeshRequestOptions = {}): Promise<T> {
    if (this.#fatal) return Promise.reject(this.#fatal);
    const ws = this.#ws;
    if (this.#closed || !this.#ready || !ws) {
      return Promise.reject(new AdapterError('upstream_unavailable', 'Not connected to MeshCentral'));
    }
    const responseid = randomUUID();
    const byTag = opts.correlate === 'tag';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(responseid);
        reject(new AdapterError('upstream_timeout', `No response to ${action}`));
      }, this.#opts.requestTimeoutMs);
      this.#pending.set(responseid, { byTag, resolve: resolve as (v: unknown) => void, reject, timer });
      // Tag rejimida tag === responseid: muvaffaqiyat javobi tag bilan, rad javobi responseid bilan keladi.
      ws.send(JSON.stringify({ action, ...payload, responseid, ...(byTag ? { tag: responseid } : {}) }));
    });
  }

  onMessage(handler: (msg: unknown) => void): Unsubscribe {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onResync(handler: () => void): Unsubscribe {
    this.#resyncHandlers.add(handler);
    return () => this.#resyncHandlers.delete(handler);
  }

  #open(): Promise<void> {
    const { url, username, password, ca, servername, maxMessageBytes, connectTimeoutMs, heartbeatIntervalMs } =
      this.#opts;
    const auth = `${Buffer.from(username).toString('base64')},${Buffer.from(password).toString('base64')}`;
    // servername ws tiplarida yo'q, lekin tls.connect'ga uzatiladi: SNI va hostname tekshiruvi shu nom bilan.
    const options: WebSocket.ClientOptions & { servername: string } = {
      ca,
      servername: servername ?? new URL(url).hostname,
      maxPayload: maxMessageBytes,
      handshakeTimeout: connectTimeoutMs,
      headers: { 'x-meshauth': auth },
    };
    const ws = new WebSocket(url, options);
    this.#ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let failure: AdapterError | undefined;
      const settle = (err?: AdapterError) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      // Osilgan server (serverinfo yo'q) oddiy uzilish kabi yopiladi, shunda reconnect davom etadi.
      const readyTimer = setTimeout(() => {
        failure ??= new AdapterError('upstream_timeout', 'MeshCentral did not become ready');
        ws.terminate();
      }, connectTimeoutMs);
      let heartbeat: NodeJS.Timeout | undefined;
      let alive = true;
      ws.on('pong', () => {
        alive = true;
      });

      ws.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        const msg = parsed as Message;
        if (msg.action === 'close' && msg.cause === 'noauth') {
          failure = new AdapterError('upstream_auth_failed', 'MeshCentral rejected credentials', msg.msg);
          return;
        }
        if (msg.action === 'serverinfo' && !this.#ready) {
          const reconnected = this.#attempt > 0;
          this.#ready = true;
          this.#attempt = 0;
          clearTimeout(readyTimer);
          heartbeat = setInterval(() => {
            if (!alive) {
              ws.terminate();
              return;
            }
            alive = false;
            ws.ping();
          }, heartbeatIntervalMs);
          settle();
          if (reconnected) for (const h of this.#resyncHandlers) notify(h);
          return;
        }
        let id = typeof msg.responseid === 'string' ? msg.responseid : undefined;
        let pending = id === undefined ? undefined : this.#pending.get(id);
        if (!pending && typeof msg.tag === 'string') {
          const tagged = this.#pending.get(msg.tag);
          if (tagged?.byTag) {
            id = msg.tag;
            pending = tagged;
          }
        }
        if (pending && id !== undefined) {
          this.#pending.delete(id);
          clearTimeout(pending.timer);
          if (msg.result === undefined || msg.result === 'ok') pending.resolve(msg);
          else pending.reject(new AdapterError('upstream_rejected', `MeshCentral rejected ${msg.action}`, msg.result));
          return;
        }
        for (const h of this.#messageHandlers) notify(() => h(msg));
      });

      ws.on('error', (err: Error & { code?: string }) => {
        if (!this.#ready && TLS_ERROR.test(err.code ?? '')) {
          failure ??= new AdapterError('upstream_tls_failed', `TLS verification failed: ${err.code}`);
        }
        failure ??= new AdapterError('upstream_unavailable', err.message);
      });

      ws.on('close', () => {
        clearTimeout(readyTimer);
        clearInterval(heartbeat);
        const wasReady = this.#ready;
        this.#ready = false;
        this.#failPending('upstream_unavailable', 'Connection to MeshCentral lost');
        const err = failure ?? new AdapterError('upstream_unavailable', 'Connection closed before ready');
        if (err.code === 'upstream_auth_failed' || err.code === 'upstream_tls_failed') {
          if (wasReady || this.#attempt > 0) this.#fatal = err;
          settle(err);
          return;
        }
        settle(err);
        // Birinchi connect() muvaffaqiyatsiz bo'lsa, qaror chaqiruvchida; keyin esa o'zimiz qayta ulanamiz.
        if (wasReady || this.#attempt > 0) this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    const { minDelayMs, maxDelayMs } = this.#opts.reconnect;
    const cap = Math.min(maxDelayMs, minDelayMs * 2 ** this.#attempt);
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      this.#open().catch(() => {});
    }, Math.random() * cap);
  }

  #failPending(code: AdapterErrorCode, message: string) {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new AdapterError(code, message));
      this.#pending.delete(id);
    }
  }
}

// Subscriber xatosi transportni yiqitmaydi va qolgan subscriber'larni to'xtatmaydi; ogohlantirish sifatida chiqadi.
function notify(handler: () => void) {
  try {
    handler();
  } catch (err) {
    process.emitWarning(err instanceof Error ? err : new Error(String(err)), 'MeshControlClientSubscriberError');
  }
}
