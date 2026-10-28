import { describe, expect, test } from 'vitest';
import { companionPresence, HEARTBEAT_INTERVAL_MS, STALE_AFTER_MS } from '../src/index.ts';

describe('companionPresence', () => {
  test('presence boundary', () => {
    const now = 1_000_000;
    expect(companionPresence(null, now)).toBe('never');
    expect(companionPresence(now - 29_999, now)).toBe('online');
    expect(companionPresence(now - 30_000, now)).toBe('stale');
    // Soat orqaga ketgan bo'lsa ham yangi heartbeat online hisoblanadi.
    expect(companionPresence(now + 5_000, now)).toBe('online');
  });

  test('constants match the spec', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(STALE_AFTER_MS).toBe(30_000);
  });
});
