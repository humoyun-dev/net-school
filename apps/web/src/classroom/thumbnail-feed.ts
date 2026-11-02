// O'qituvchi miniatura oqimi klienti: binary xabar = 16 bayt qurilma UUID + JPEG. Har qurilmaning faqat oxirgi
// blob URL'i tirik (eskisi darhol bo'shatiladi — 90 daqiqalik darsda xotira o'smaydi).
interface Deps {
  WebSocket: typeof WebSocket;
  URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  accept: (deviceId: string) => boolean;
  onUnauthenticated?: () => void;
  onEnded?: () => void;
  retryMs?: number;
}

const RETRY_MIN_MS = 1_000;
// Upgrade rad etilsa brauzer faqat 1006 ko'radi: shuncha marta bir marta ham ochilmasa to'xtaymiz (audit to'lmasin).
const MAX_REFUSALS = 5;
const RETRY_MAX_MS = 30_000;

function uuidOf(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ThumbnailFeed {
  readonly #url: string;
  readonly #onFrame: (deviceId: string, objectUrl: string) => void;
  readonly #deps: Deps;
  readonly #urls = new Map<string, string>();
  #socket: WebSocket | null = null;
  #retryMs = RETRY_MIN_MS;
  #minRetryMs = RETRY_MIN_MS;
  #refusals = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(url: string, onFrame: (deviceId: string, objectUrl: string) => void, deps: Partial<Deps> = {}) {
    this.#url = url;
    this.#onFrame = onFrame;
    this.#deps = {
      WebSocket: deps.WebSocket ?? WebSocket,
      URL: deps.URL ?? URL,
      accept: deps.accept ?? (() => true),
      onUnauthenticated: deps.onUnauthenticated,
      onEnded: deps.onEnded,
    };
    this.#minRetryMs = deps.retryMs ?? RETRY_MIN_MS;
    this.#retryMs = this.#minRetryMs;
    this.#connect();
  }

  #connect(): void {
    const ws = new this.#deps.WebSocket(this.#url);
    ws.binaryType = 'arraybuffer';
    this.#socket = ws;
    ws.onopen = () => {
      this.#retryMs = this.#minRetryMs;
      this.#refusals = 0;
    };
    ws.onmessage = (e: MessageEvent) => {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength <= 16) return;
      const deviceId = uuidOf(new Uint8Array(e.data, 0, 16));
      if (!this.#deps.accept(deviceId)) return;
      const url = this.#deps.URL.createObjectURL(new Blob([e.data.slice(16)], { type: 'image/jpeg' }));
      const prev = this.#urls.get(deviceId);
      this.#urls.set(deviceId, url);
      if (prev) this.#deps.URL.revokeObjectURL(prev);
      this.#onFrame(deviceId, url);
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.#closed || this.#socket !== ws) return;
      if (e.code === 4401) return this.#deps.onUnauthenticated?.();
      if (e.code === 4410) return this.#deps.onEnded?.();
      this.#refusals += 1;
      if (this.#refusals >= MAX_REFUSALS) return this.#deps.onEnded?.();
      this.#timer = setTimeout(() => this.#connect(), this.#retryMs);
      this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
    };
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#socket?.close();
    for (const url of this.#urls.values()) this.#deps.URL.revokeObjectURL(url);
    this.#urls.clear();
  }
}
