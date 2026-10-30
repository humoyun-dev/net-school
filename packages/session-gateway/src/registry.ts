import { randomBytes } from 'node:crypto';
import { sha256 } from './hash.ts';
import type { GatewayCloseReason, UpstreamViewerSession } from './types.ts';

export interface GatewaySession {
  id: string;
  upstream: UpstreamViewerSession;
  sockets: Set<{ close(code?: number): void }>;
  closed: boolean;
}

const POLICY_VIOLATION = 1008;

export class SessionRegistry {
  readonly #sessions = new Map<string, GatewaySession>();
  readonly #cookies = new Map<string, string>(); // cookie SHA-256 -> sessionId
  readonly #revoking = new Map<string, Promise<void>>();

  add(id: string, upstream: UpstreamViewerSession): GatewaySession {
    if (this.#sessions.has(id)) throw new Error(`Session already registered: ${id}`);
    const session: GatewaySession = { id, upstream, sockets: new Set(), closed: false };
    this.#sessions.set(id, session);
    return session;
  }

  // Yangi 32 baytli cookie qiymati; faqat hash saqlanadi.
  bindCookie(sessionId: string): string {
    const session = this.#sessions.get(sessionId);
    if (!session || session.closed) throw new Error(`Session is not open: ${sessionId}`);
    const value = randomBytes(32).toString('base64url');
    this.#cookies.set(sha256(value), sessionId);
    return value;
  }

  byCookie(value: string | undefined): GatewaySession | undefined {
    if (!value) return undefined;
    const id = this.#cookies.get(sha256(value));
    const session = id === undefined ? undefined : this.#sessions.get(id);
    return session && !session.closed ? session : undefined;
  }

  get(id: string): GatewaySession | undefined {
    return this.#sessions.get(id);
  }

  // Faqat lokal yopish: cookie'lar va socketlar (1008), upstream revoke'siz. Keyingi close() faqat revoke qiladi.
  drop(id: string): void {
    const session = this.#sessions.get(id);
    if (!session || session.closed) return;
    session.closed = true;
    this.#dropCookies(id);
    for (const socket of [...session.sockets]) {
      try {
        socket.close(POLICY_VIOLATION);
      } catch {
        // bitta socketdagi xato qolganlarini to'xtatmaydi
      }
    }
  }

  // Avval socketlar (1008), keyin upstream.revoke(). revoke xatosi qayta otiladi, sessiya baribir yopiq.
  // Takroriy chaqiruv: revoke jarayonda bo'lsa o'sha va'da. Muvaffaqiyatli revoke'dan keyin sessiya registry'dan
  // o'chiriladi (uzoq yashaydigan jarayonda xotira o'smaydi) — keyingi close() noma'lum id kabi hech nima qilmaydi.
  // Muvaffaqiyatsiz revoke keyingi close()da qayta uriniladi.
  close(id: string, _reason: GatewayCloseReason): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return Promise.resolve();
    const inFlight = this.#revoking.get(id);
    if (inFlight) return inFlight;

    this.drop(id);
    const revoking = (async () => session.upstream.revoke())().then(
      () => {
        this.#revoking.delete(id);
        this.#sessions.delete(id);
      },
      (err: unknown) => {
        this.#revoking.delete(id);
        throw err;
      },
    );
    this.#revoking.set(id, revoking);
    return revoking;
  }

  #dropCookies(sessionId: string): void {
    for (const [hash, id] of this.#cookies) {
      if (id === sessionId) this.#cookies.delete(hash);
    }
  }
}
