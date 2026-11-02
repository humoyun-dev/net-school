import type { Agent } from 'node:https';
import { THUMBNAIL_CLIENT_MIN_INTERVAL_MS, THUMBNAIL_MAX_BYTES } from '@netschool/domain';
import { WebSocket } from 'ws';
import type { HubClient } from './hub-client.ts';
import type { RequestSigner, SignedHeaders } from './identity.ts';

// Ekran kadri manbai: JPEG yoki null (ruxsat yo'q / bo'sh kadr). Kadr hech qayerga yozilmaydi.
export interface FrameSource {
  capture(maxWidth: number): Promise<Buffer | null>;
}

export interface ThumbnailSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Buffer): void;
  close(code?: number): void;
  on(event: 'open' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
}

export type ConnectSocket = (url: string, headers: SignedHeaders, agent: Agent) => ThumbnailSocket;

const THUMBNAIL_PATH = '/api/v1/device/thumbnails';
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Hub yopish kodlari: 4409 — qurilma darsda emas; 4000 — shu qurilmaning boshqa oqimi almashtirdi.
// Ikkalasida ham keyingi `start()` gacha (heartbeat yo'riqnomasi) qayta ulanilmaydi: aks holda ikki nusxa kurashadi.
const CLOSE_LEFT_LESSON = 4409;
const CLOSE_REPLACED = 4000;
const CLOSE_NORMAL = 1000;

// Hub'ga ulanadigan haqiqiy soket: TLS/CA hub klienti bilan bir xil agent; kadrlar JPEG, siqish foyda bermaydi.
const connectWs: ConnectSocket = (url, headers, agent) =>
  new WebSocket(url, {
    headers,
    agent,
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  }) as unknown as ThumbnailSocket;

interface Directive {
  intervalMs: number;
  maxWidth: number;
}

// Dars davomida miniaturani hub'ga yuboradi (spec §11): faqat oxirgi kadr kerak, shuning uchun soket band bo'lsa
// kadr olinmaydi (navbat yo'q, xotira o'smaydi).
export class ThumbnailUploader {
  readonly #hub: HubClient;
  readonly #signer: RequestSigner;
  readonly #source: FrameSource;
  readonly #connect: ConnectSocket;
  #directive: Directive | null = null;
  #socket: ThumbnailSocket | null = null;
  #open = false;
  // Hub shu oqimni rad etdi (4409/4000): keyingi start() gacha kutiladi.
  #blocked = false;
  #capturing = false;
  #backoffMs = BACKOFF_MIN_MS;
  #tickTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(deps: { hub: HubClient; signer: RequestSigner; source: FrameSource; connect?: ConnectSocket }) {
    this.#hub = deps.hub;
    this.#signer = deps.signer;
    this.#source = deps.source;
    this.#connect = deps.connect ?? connectWs;
  }

  get streaming(): boolean {
    return this.#open;
  }

  // Har heartbeat'da chaqirilishi mumkin: ishlab turgan oqimda hech narsa qilmaydi (yo'riqnoma o'zgarsa yangilanadi).
  start(directive: Directive): void {
    const next = {
      intervalMs: Math.max(directive.intervalMs, THUMBNAIL_CLIENT_MIN_INTERVAL_MS),
      maxWidth: directive.maxWidth,
    };
    const changed =
      this.#directive === null ||
      this.#directive.intervalMs !== next.intervalMs ||
      this.#directive.maxWidth !== next.maxWidth;
    this.#directive = next;
    if (this.#blocked) {
      this.#blocked = false;
      this.#backoffMs = BACKOFF_MIN_MS;
      this.#connectNow();
      return;
    }
    if (this.#socket || this.#reconnectTimer) {
      if (changed && this.#open) this.#scheduleTick(next.intervalMs);
      return;
    }
    this.#connectNow();
  }

  stop(): void {
    this.#directive = null;
    this.#blocked = false;
    this.#backoffMs = BACKOFF_MIN_MS;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    this.#open = false;
    // Avval #socket = null: yopilish hodisasi eskirgan deb e'tiborsiz qoldiriladi.
    socket?.close(CLOSE_NORMAL);
  }

  #clearTimers(): void {
    if (this.#tickTimer) clearTimeout(this.#tickTimer);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#tickTimer = this.#reconnectTimer = null;
  }

  #connectNow(): void {
    this.#reconnectTimer = null;
    let socket: ThumbnailSocket;
    try {
      const headers = this.#signer.sign('GET', THUMBNAIL_PATH, Buffer.alloc(0));
      socket = this.#connect(
        `${this.#hub.origin.replace(/^https:/, 'wss:')}${THUMBNAIL_PATH}`,
        headers,
        this.#hub.agent,
      );
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.on('open', () => {
      if (this.#socket !== socket) return;
      this.#open = true;
      this.#backoffMs = BACKOFF_MIN_MS;
      this.#scheduleTick(0);
    });
    // 'error'dan keyin har doim 'close' keladi: qayta ulanish faqat shu yerda.
    socket.on('error', () => {});
    socket.on('close', (code) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#open = false;
      this.#clearTimers();
      if (code === CLOSE_LEFT_LESSON || code === CLOSE_REPLACED) this.#blocked = true;
      else if (this.#directive) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (!this.#directive) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(delay * 2, BACKOFF_MAX_MS);
    this.#reconnectTimer = setTimeout(() => this.#connectNow(), delay);
  }

  #scheduleTick(delayMs: number): void {
    if (this.#tickTimer) clearTimeout(this.#tickTimer);
    this.#tickTimer = setTimeout(() => void this.#tick(), delayMs);
  }

  async #tick(): Promise<void> {
    const directive = this.#directive;
    const socket = this.#socket;
    if (!directive || !socket || !this.#open) return;
    // Keyingi tick avval rejalashtiriladi: kadr sekin olinsa ham sur'at siljimaydi.
    this.#scheduleTick(directive.intervalMs);
    if (this.#capturing || socket.bufferedAmount > 0) return;
    this.#capturing = true;
    try {
      const frame = await this.#source.capture(directive.maxWidth);
      // Capture davomida stop() yoki uzilish bo'lgan bo'lsa kadr yuborilmaydi.
      if (frame && frame.length <= THUMBNAIL_MAX_BYTES && this.#socket === socket && this.#open) socket.send(frame);
    } catch {
      // Bitta kadr tushib qoladi; sikl davom etadi.
    } finally {
      this.#capturing = false;
    }
  }
}
