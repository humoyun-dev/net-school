import type { RemoteSession } from '@netschool/contracts';

// REMOTE_RENEW_INTERVAL_MS (domain) bilan bir xil: lease 30 s, yangilash 10 s.
export const RENEW_INTERVAL_MS = 10_000;

export type ViewerMode = 'view' | 'control';
export type ViewerState =
  | { kind: 'opening' }
  | { kind: 'open'; url: string; mode: ViewerMode; session: RemoteSession }
  | { kind: 'closed'; reason: 'closed' | 'control_busy' | 'expired' | 'lesson_ended' | 'error'; code?: string };

// HTTP xatosi (status + API kodi). Tarmoq xatosi bu turdagi emas.
export class ViewerApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'ViewerApiError';
    this.status = status;
    this.code = code;
  }
}

// Panel API'sining viewer uchun kerakli qismi (paket apps/web'ga bog'lanmaydi).
export interface ViewerApi {
  openSession(lessonId: string, deviceId: string, mode: ViewerMode, idempotencyKey: string): Promise<RemoteSession>;
  ticket(sessionId: string): Promise<{ url: string }>;
  renew(sessionId: string, fencing: string | undefined): Promise<RemoteSession>;
  close(sessionId: string): Promise<void>;
}

// Fon tabida ham ishlaydigan taymer (Web Worker); controller boshqa taymer ishlatmaydi.
export interface RenewTimer {
  start(everyMs: number, tick: () => void): void;
  stop(): void;
}

function closedReason(session: RemoteSession): Extract<ViewerState, { kind: 'closed' }>['reason'] {
  if (session.closeReason === 'lesson_ended' || session.closeReason === 'device_left') return 'lesson_ended';
  if (session.closeReason === 'lease_expired') return 'expired';
  return 'closed';
}

export class RemoteSessionController {
  readonly #api: ViewerApi;
  readonly #timer: RenewTimer;
  readonly #key: () => string;
  readonly #listeners = new Set<(s: ViewerState) => void>();
  #state: ViewerState = { kind: 'closed', reason: 'closed' };
  #session: RemoteSession | null = null;
  #renewing = false;
  // Har open/close yangi avlod: kechikkan javob yopilgan panel sessiyasini tiriltirmaydi.
  #generation = 0;

  constructor(deps: { api: ViewerApi; timer: RenewTimer; idempotencyKey: () => string }) {
    this.#api = deps.api;
    this.#timer = deps.timer;
    this.#key = deps.idempotencyKey;
  }

  get state(): ViewerState {
    return this.#state;
  }

  subscribe(listener: (s: ViewerState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: ViewerState): void {
    this.#state = state;
    for (const l of this.#listeners) l(state);
  }

  #fail(err: unknown): void {
    this.#timer.stop();
    if (err instanceof ViewerApiError && err.code === 'control_busy') {
      this.#set({ kind: 'closed', reason: 'control_busy', code: err.code });
    } else {
      this.#set({ kind: 'closed', reason: 'error', ...(err instanceof ViewerApiError ? { code: err.code } : {}) });
    }
  }

  async open(lessonId: string, deviceId: string, mode: ViewerMode): Promise<void> {
    const gen = ++this.#generation;
    this.#set({ kind: 'opening' });
    let session: RemoteSession | null = null;
    try {
      session = await this.#api.openSession(lessonId, deviceId, mode, this.#key());
      // Kutish paytida yopildi: sessiya darhol o'chiriladi, yangilash boshlanmaydi.
      if (gen !== this.#generation) return void (await this.#api.close(session.id).catch(() => {}));
      this.#session = session;
      if (session.status !== 'active') {
        this.#set({ kind: 'closed', reason: closedReason(session) });
        return;
      }
      const { url } = await this.#api.ticket(session.id);
      if (gen !== this.#generation) return;
      this.#set({ kind: 'open', url, mode, session });
      this.#timer.start(RENEW_INTERVAL_MS, () => void this.#renew());
    } catch (err) {
      if (gen === this.#generation) this.#fail(err);
    }
  }

  async #renew(): Promise<void> {
    const session = this.#session;
    const state = this.#state;
    const gen = this.#generation;
    if (!session || state.kind !== 'open' || this.#renewing) return;
    this.#renewing = true;
    try {
      const fencing = state.mode === 'control' ? (session.lease?.fencing ?? undefined) : undefined;
      const next = await this.#api.renew(session.id, fencing);
      if (gen !== this.#generation || this.#state.kind !== 'open') return;
      this.#session = next;
      if (next.status !== 'active') {
        this.#timer.stop();
        this.#set({ kind: 'closed', reason: closedReason(next) });
        return;
      }
      this.#set({ ...state, session: next });
    } catch (err) {
      if (!(err instanceof ViewerApiError)) return; // tarmoq: keyingi tick qayta urinadi (lease 30 s)
      this.#timer.stop();
      if (err.status === 409 || err.status === 404) this.#set({ kind: 'closed', reason: 'expired', code: err.code });
      else this.#set({ kind: 'closed', reason: 'error', code: err.code });
    } finally {
      this.#renewing = false;
    }
  }

  async close(): Promise<void> {
    this.#generation += 1;
    this.#timer.stop();
    const session = this.#session;
    this.#session = null;
    this.#set({ kind: 'closed', reason: 'closed' });
    if (session) await this.#api.close(session.id).catch(() => {});
  }
}
