import type { HeartbeatLesson } from '@netschool/contracts';
import { describe, expect, test, vi } from 'vitest';
import { StateCache } from '../src/core/cache.ts';
import { type ClockSources, createClock } from '../src/core/clock.ts';
import { OverlayController, type OverlayView } from '../src/core/overlay.ts';

const LESSON = '7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a';
const OTHER_LESSON = '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';
const WALL_START = 1_800_000_000_000;

// Qo'lda boshqariladigan manbalar: monoton taymer, OS uptime va devor soati alohida suriladi.
function sources(init: { perfMs?: number; uptimeMs?: number; wallMs?: number } = {}) {
  const s = { perfMs: init.perfMs ?? 0, uptimeMs: init.uptimeMs ?? 5_000_000, wallMs: init.wallMs ?? WALL_START };
  const src: ClockSources = {
    perfNowMs: () => s.perfMs,
    uptimeSeconds: () => s.uptimeMs / 1000,
    wallMs: () => s.wallMs,
  };
  // Haqiqiy vaqt o'tishi: monoton ham, uptime ham, devor soati ham.
  const advance = (ms: number) => {
    s.perfMs += ms;
    s.uptimeMs += ms;
    s.wallMs += ms;
  };
  return { s, src, advance };
}

function harness(init: Parameters<typeof sources>[0] = {}, cache: StateCache = StateCache.open(':memory:')) {
  const t = sources(init);
  const changes: OverlayView[] = [];
  const overlay = new OverlayController(createClock(t.src), cache, (v) => changes.push(v));
  return { ...t, cache, overlay, changes };
}

function heartbeat(
  over: { locked?: boolean; sequence?: string | null; leaseSeconds?: number; id?: string } = {},
): HeartbeatLesson {
  return {
    id: over.id ?? LESSON,
    overlay: {
      locked: over.locked ?? true,
      sequence: over.sequence === undefined ? '10' : over.sequence,
      leaseExpiresAt: '2026-11-02T08:02:00.000Z',
      leaseSeconds: over.leaseSeconds ?? 120,
    },
    thumbnails: { intervalMs: 1_000, maxWidth: 480 },
    helpRequest: null,
  };
}

const lock = (sequence: string, message?: string, lessonId = LESSON) =>
  ({ type: 'overlay.lock', sequence, lessonId, ...(message ? { message } : {}) }) as const;
const unlock = (sequence: string, lessonId = LESSON) => ({ type: 'overlay.unlock', sequence, lessonId }) as const;

describe('overlay lease', () => {
  test('heartbeat lock holds only within the lease', () => {
    const h = harness();
    h.overlay.applyHeartbeat(heartbeat({ leaseSeconds: 120 }));
    expect(h.overlay.view()).toEqual({ locked: true, message: null, lessonId: LESSON });

    h.advance(119_999);
    h.overlay.tick();
    expect(h.overlay.view().locked).toBe(true);
    h.advance(1);
    h.overlay.tick();
    expect(h.overlay.view()).toEqual({ locked: false, message: null, lessonId: LESSON });
    expect(h.changes.map((v) => v.locked)).toEqual([true, false]);
  });

  test('a heartbeat for the same lock renews the lease', () => {
    const h = harness();
    h.overlay.applyHeartbeat(heartbeat());
    h.advance(100_000);
    h.overlay.applyHeartbeat(heartbeat());
    h.advance(119_999);
    h.overlay.tick();
    expect(h.overlay.view().locked).toBe(true);
    h.advance(1);
    h.overlay.tick();
    expect(h.overlay.view().locked).toBe(false);
  });

  test('server silence releases the overlay after 120 seconds', () => {
    const h = harness();
    expect(h.overlay.applyCommand(lock('10', 'Diqqat!'))).toBe('applied');
    expect(h.overlay.view()).toEqual({ locked: true, message: 'Diqqat!', lessonId: LESSON });
    h.advance(119_999);
    h.overlay.tick();
    expect(h.overlay.view().locked).toBe(true);
    h.advance(1);
    h.overlay.tick();
    expect(h.overlay.view()).toEqual({ locked: false, message: null, lessonId: LESSON });
    expect(h.cache.loadOverlay()).toBeNull();
  });

  test('a lock that expired while the hub was silent returns when the hub confirms it', () => {
    const h = harness();
    h.overlay.applyCommand(lock('10'));
    h.advance(120_000);
    h.overlay.tick();
    expect(h.overlay.view().locked).toBe(false);
    h.overlay.applyHeartbeat(heartbeat({ sequence: '10' }));
    expect(h.overlay.view().locked).toBe(true);
  });

  test('older sequence never overrides a newer one', () => {
    const h = harness();
    expect(h.overlay.applyCommand(lock('10'))).toBe('applied');
    // Eskiroq heartbeat holatni ham, lease'ni ham o'zgartirmaydi.
    h.advance(60_000);
    h.overlay.applyHeartbeat(heartbeat({ locked: false, sequence: '9' }));
    expect(h.overlay.view().locked).toBe(true);
    expect(h.overlay.applyCommand(unlock('9'))).toBe('stale');
    expect(h.overlay.view().locked).toBe(true);
    h.advance(59_999);
    h.overlay.tick();
    expect(h.overlay.view().locked).toBe(true); // lease yangilanmadi: 120 s lock vaqtidan sanaladi
    h.advance(1);
    h.overlay.tick();
    expect(h.overlay.view().locked).toBe(false);

    // Yangiroq unlock o'tadi, undan keyin eski lock qayta kelsa ham ochiq qoladi.
    expect(h.overlay.applyCommand(lock('20'))).toBe('applied');
    expect(h.overlay.applyCommand(unlock('21'))).toBe('applied');
    expect(h.overlay.view().locked).toBe(false);
    h.overlay.applyHeartbeat(heartbeat({ locked: true, sequence: '20' }));
    expect(h.overlay.view().locked).toBe(false);
    expect(h.overlay.applyCommand(lock('20'))).toBe('stale');
  });

  test('a null sequence ranks below every real sequence and a malformed one is ignored', () => {
    const h = harness();
    h.overlay.applyHeartbeat(heartbeat({ locked: false, sequence: null }));
    expect(h.overlay.applyCommand(lock('1'))).toBe('applied');
    h.overlay.applyHeartbeat(heartbeat({ locked: false, sequence: null }));
    expect(h.overlay.view().locked).toBe(true);
    expect(h.overlay.applyCommand(unlock('not-a-number'))).toBe('stale');
    h.overlay.applyHeartbeat(heartbeat({ locked: false, sequence: '2x' }));
    expect(h.overlay.view().locked).toBe(true);
  });

  test('a wall-clock jump does not extend the lease', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = harness();
      h.overlay.applyCommand(lock('10'));
      // Devor soati bir soat oldinga/orqaga sakraydi; monoton taymer o'zgarmaydi.
      h.s.wallMs += 3_600_000;
      vi.setSystemTime(h.s.wallMs);
      h.s.perfMs += 119_999;
      h.s.uptimeMs += 119_999;
      h.overlay.tick();
      expect(h.overlay.view().locked).toBe(true);
      h.s.wallMs -= 7_200_000;
      vi.setSystemTime(h.s.wallMs);
      h.s.perfMs += 1;
      h.s.uptimeMs += 1;
      h.overlay.tick();
      expect(h.overlay.view().locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('sleep counts: the lease also ends when only the OS uptime kept running', () => {
    const h = harness();
    h.overlay.applyCommand(lock('10'));
    // Kompyuter uxlab qoldi: process taymeri to'xtagan (macOS), OS uptime davom etgan.
    h.s.uptimeMs += 120_000;
    h.overlay.tick();
    expect(h.overlay.view().locked).toBe(false);
  });

  test('restart within the same boot restores the remaining lease', () => {
    const file = StateCache.open(':memory:');
    const first = harness({}, file);
    first.overlay.applyCommand(lock('10', 'Diqqat'));
    first.advance(30_000);
    first.overlay.applyHeartbeat(heartbeat({ sequence: '10' })); // lease 120 s ga yangilandi (t=30 s)
    first.advance(10_000);

    // Yangi jarayon: monoton taymer noldan, OS uptime va devor soati davom etgan.
    const second = harness({ perfMs: 0, uptimeMs: first.s.uptimeMs, wallMs: first.s.wallMs }, file);
    second.overlay.restore();
    expect(second.overlay.view()).toEqual({ locked: true, message: 'Diqqat', lessonId: LESSON });
    expect(second.changes).toEqual([{ locked: true, message: 'Diqqat', lessonId: LESSON }]);
    second.advance(109_999); // qolgan lease: 120 s − 10 s
    second.overlay.tick();
    expect(second.overlay.view().locked).toBe(true);
    second.advance(1);
    second.overlay.tick();
    expect(second.overlay.view().locked).toBe(false);
    // Tiklangan holat eski sequence bilan solishtiriladi.
    expect(second.overlay.applyCommand(unlock('9'))).toBe('stale');
  });

  test('reboot discards the cached lock', () => {
    const cache = StateCache.open(':memory:');
    const first = harness({}, cache);
    first.overlay.applyCommand(lock('10'));
    expect(cache.loadOverlay()).not.toBeNull();

    // Reboot: OS uptime nolga yaqin, devor soati oldinga ketgan — boshqa boot.
    const second = harness({ perfMs: 0, uptimeMs: 20_000, wallMs: first.s.wallMs + 600_000 }, cache);
    second.overlay.restore();
    expect(second.overlay.view().locked).toBe(false);
    expect(second.changes).toEqual([]);
    expect(cache.loadOverlay()).toBeNull();
  });

  test('a cached lock whose lease already ran out is discarded on restore', () => {
    const cache = StateCache.open(':memory:');
    const first = harness({}, cache);
    first.overlay.applyCommand(lock('10'));
    first.advance(120_001);
    const second = harness({ perfMs: 0, uptimeMs: first.s.uptimeMs, wallMs: first.s.wallMs }, cache);
    second.overlay.restore();
    expect(second.overlay.view().locked).toBe(false);
    expect(cache.loadOverlay()).toBeNull();
  });

  test('lesson ending unlocks immediately', () => {
    const h = harness();
    h.overlay.applyCommand(lock('10', 'Diqqat'));
    h.overlay.applyHeartbeat(null);
    expect(h.overlay.view()).toEqual({ locked: false, message: null, lessonId: null });
    expect(h.cache.loadOverlay()).toBeNull();
    expect(h.changes.map((v) => v.locked)).toEqual([true, false]);
    // Keyingi darsning (yangiroq sequence) lock'i o'tadi.
    h.overlay.applyHeartbeat(heartbeat({ id: OTHER_LESSON, sequence: '30' }));
    expect(h.overlay.view()).toEqual({ locked: true, message: null, lessonId: OTHER_LESSON });
  });

  test('a heartbeat for another lesson replaces the previous lesson state', () => {
    const h = harness();
    h.overlay.applyCommand(lock('10', 'Diqqat'));
    h.overlay.applyHeartbeat(heartbeat({ id: OTHER_LESSON, locked: false, sequence: '15' }));
    expect(h.overlay.view()).toEqual({ locked: false, message: null, lessonId: OTHER_LESSON });
  });

  test('a heartbeat renewing the same lock keeps its message', () => {
    const h = harness();
    h.overlay.applyCommand(lock('10', 'Diqqat'));
    h.overlay.applyHeartbeat(heartbeat({ sequence: '10' }));
    expect(h.overlay.view().message).toBe('Diqqat');
    // Yangi sequence heartbeat orqali kelsa (buyruq hali yetmagan) xabar noma'lum.
    h.overlay.applyHeartbeat(heartbeat({ sequence: '11' }));
    expect(h.overlay.view()).toEqual({ locked: true, message: null, lessonId: LESSON });
  });
});
