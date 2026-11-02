import type { HeartbeatLesson } from '@netschool/contracts';
import type { StateCache } from './cache.ts';
import type { MonotonicClock } from './clock.ts';

export interface OverlayView {
  locked: boolean;
  message: string | null;
  lessonId: string | null;
}

// Buyruq bilan kelgan lock ham heartbeat lease'i qadar turadi (hub OVERLAY_LEASE_MS = 120 s).
const DEFAULT_LEASE_MS = 120_000;
// Bir boot ekanini aniqlashda devor soati aniqligi.
const BOOT_TOLERANCE_MS = 2_000;
const NO_SEQUENCE = -1n;

interface State {
  locked: boolean;
  message: string | null;
  lessonId: string | null;
  sequence: bigint;
  // Lease ikki soat bilan o'lchanadi: monoton taymer (jarayon ichida) va OS uptime (restart va uyqudan keyin ham).
  // Qaysi biri avval tugasa overlay tushadi.
  deadlineMs: number;
  deadlineUptimeMs: number;
}

const IDLE: State = {
  locked: false,
  message: null,
  lessonId: null,
  sequence: NO_SEQUENCE,
  deadlineMs: 0,
  deadlineUptimeMs: 0,
};

// Server qiymati: butun son qatori yoki null (hali holat yo'q). Boshqa narsa — noma'lum, e'tiborsiz qoldiriladi.
function parseSequence(value: string | null): bigint | null {
  if (value === null) return NO_SEQUENCE;
  return /^\d{1,30}$/.test(value) ? BigInt(value) : null;
}

// Yumshoq overlay holati (spec §10): lease tugasa yoki dars tugasa o'zi tushadi; faqat yangiroq `sequence` holatni
// o'zgartiradi; reboot'dan keyin eskirgan lock qaytmaydi.
export class OverlayController {
  readonly #clock: MonotonicClock;
  readonly #cache: StateCache;
  readonly #onChange: (view: OverlayView) => void;
  #state: State = IDLE;

  constructor(clock: MonotonicClock, cache: StateCache, onChange: (view: OverlayView) => void) {
    this.#clock = clock;
    this.#cache = cache;
    this.#onChange = onChange;
  }

  view(): OverlayView {
    return { locked: this.#state.locked, message: this.#state.message, lessonId: this.#state.lessonId };
  }

  // Ishga tushganda: saqlangan lock faqat shu boot ichida va lease tugamagan bo'lsa tiklanadi.
  restore(): void {
    const saved = this.#cache.loadOverlay();
    if (!saved) return;
    const sameBoot = Math.abs(saved.bootTimeMs - this.#clock.bootTimeMs()) <= BOOT_TOLERANCE_MS;
    const remainingMs = saved.deadlineUptimeMs - this.#clock.uptimeMs();
    if (!saved.locked || !sameBoot || remainingMs <= 0) {
      this.#cache.saveOverlay(null);
      return;
    }
    const sequence = parseSequence(saved.sequence) ?? NO_SEQUENCE;
    this.#commit({
      locked: true,
      message: saved.message,
      lessonId: saved.lessonId,
      sequence,
      deadlineMs: this.#clock.nowMs() + remainingMs,
      deadlineUptimeMs: saved.deadlineUptimeMs,
    });
  }

  applyHeartbeat(lesson: HeartbeatLesson | null): void {
    if (lesson === null) {
      // Dars tugadi (yoki qurilma darsda emas): overlay darhol tushadi, sequence ham unutiladi.
      this.#commit({ ...IDLE });
      return;
    }
    const sequence = parseSequence(lesson.overlay.sequence);
    if (sequence === null) return;
    const current = lesson.id === this.#state.lessonId ? this.#state : { ...IDLE, lessonId: lesson.id };
    // Eskiroq sequence holatni ham, lease'ni ham o'zgartirmaydi (yangi lock/unlock allaqachon qo'llangan).
    if (sequence < current.sequence) {
      if (current !== this.#state) this.#commit(current);
      return;
    }
    const locked = lesson.overlay.locked;
    this.#commit({
      locked,
      // Xabar buyruq bilan keladi; heartbeat shu lock'ni yangilasa saqlanadi, yangi lock bo'lsa noma'lum.
      message: locked && sequence === current.sequence ? current.message : null,
      lessonId: lesson.id,
      sequence,
      ...(locked ? this.#deadlines(lesson.overlay.leaseSeconds * 1000) : { deadlineMs: 0, deadlineUptimeMs: 0 }),
    });
  }

  applyCommand(c: {
    type: 'overlay.lock' | 'overlay.unlock';
    sequence: string;
    lessonId: string;
    message?: string;
  }): 'applied' | 'stale' {
    const sequence = parseSequence(c.sequence);
    if (sequence === null || sequence < this.#state.sequence) return 'stale';
    const locked = c.type === 'overlay.lock';
    this.#commit({
      locked,
      message: locked ? (c.message ?? null) : null,
      lessonId: c.lessonId,
      sequence,
      ...(locked ? this.#deadlines(DEFAULT_LEASE_MS) : { deadlineMs: 0, deadlineUptimeMs: 0 }),
    });
    return 'applied';
  }

  // Har 1 s: lease tugagan lock tushadi. Sequence saqlanadi — hub lock'ni tasdiqlasa heartbeat uni qaytaradi.
  tick(): void {
    const s = this.#state;
    if (!s.locked) return;
    if (this.#clock.nowMs() >= s.deadlineMs || this.#clock.uptimeMs() >= s.deadlineUptimeMs) {
      this.#commit({ ...s, locked: false, message: null, deadlineMs: 0, deadlineUptimeMs: 0 });
    }
  }

  #deadlines(leaseMs: number): Pick<State, 'deadlineMs' | 'deadlineUptimeMs'> {
    return { deadlineMs: this.#clock.nowMs() + leaseMs, deadlineUptimeMs: this.#clock.uptimeMs() + leaseMs };
  }

  #commit(next: State): void {
    const before = this.view();
    this.#state = next;
    // Faqat lock saqlanadi: ochiq holatda cache bo'sh (qayta ishga tushgandan keyin qulf o'zi paydo bo'lmasin).
    this.#cache.saveOverlay(
      next.locked && next.lessonId !== null
        ? {
            lessonId: next.lessonId,
            locked: true,
            sequence: next.sequence === NO_SEQUENCE ? null : String(next.sequence),
            message: next.message,
            bootTimeMs: this.#clock.bootTimeMs(),
            deadlineUptimeMs: next.deadlineUptimeMs,
          }
        : null,
    );
    const after = this.view();
    if (before.locked !== after.locked || before.message !== after.message || before.lessonId !== after.lessonId) {
      this.#onChange(after);
    }
  }
}
