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
}

export interface MeshRequester {
  request<T = Record<string, unknown>>(action: string, payload?: Record<string, unknown>): Promise<T>;
  onMessage(handler: (msg: unknown) => void): Unsubscribe;
  onResync(handler: () => void): Unsubscribe;
}

interface Pending {
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

  request<T = Message>(action: string, payload: Message = {}): Promise<T> {
    if (this.#fatal) return Promise.reject(this.#fatal);
    const ws = this.#ws;
    if (this.#closed || !this.#ready || !ws) {
      return Promise.reject(new AdapterError('upstream_unavailable', 'Not connected to MeshCentral'));
    }
    const responseid = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(responseid);
        reject(new AdapterError('upstream_timeout', `No response to ${action}`));
      }, this.#opts.requestTimeoutMs);
      this.#pending.set(responseid, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ action, ...payload, responseid }));
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
    const { url, username, password, ca, servername, maxMessageBytes } = this.#opts;
    const auth = `${Buffer.from(username).toString('base64')},${Buffer.from(password).toString('base64')}`;
    // servername ws tiplarida yo'q, lekin tls.connect'ga uzatiladi: SNI va hostname tekshiruvi shu nom bilan.
    const options: WebSocket.ClientOptions & { servername: string } = {
      ca,
      servername: servername ?? new URL(url).hostname,
      maxPayload: maxMessageBytes,
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

      ws.on('message', (data) => {
        let msg: Message;
        try {
          msg = JSON.parse(String(data)) as Message;
        } catch {
          return;
        }
        if (msg.action === 'close' && msg.cause === 'noauth') {
          failure = new AdapterError('upstream_auth_failed', 'MeshCentral rejected credentials', msg.msg);
          return;
        }
        if (msg.action === 'serverinfo' && !this.#ready) {
          const reconnected = this.#attempt > 0;
          this.#ready = true;
          this.#attempt = 0;
          settle();
          if (reconnected) for (const h of this.#resyncHandlers) h();
          return;
        }
        const id = msg.responseid;
        const pending = typeof id === 'string' ? this.#pending.get(id) : undefined;
        if (pending && typeof id === 'string') {
          this.#pending.delete(id);
          clearTimeout(pending.timer);
          if (msg.result === undefined || msg.result === 'ok') pending.resolve(msg);
          else pending.reject(new AdapterError('upstream_rejected', `MeshCentral rejected ${msg.action}`, msg.result));
          return;
        }
        for (const h of this.#messageHandlers) h(msg);
      });

      ws.on('error', (err: Error & { code?: string }) => {
        if (!this.#ready && TLS_ERROR.test(err.code ?? '')) {
          failure ??= new AdapterError('upstream_tls_failed', `TLS verification failed: ${err.code}`);
        }
        failure ??= new AdapterError('upstream_unavailable', err.message);
      });

      ws.on('close', () => {
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
