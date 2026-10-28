import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { keepConnected } from '../src/modules/devices/mesh.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('keepConnected', () => {
  test('retries the first connection with backoff until it succeeds', async () => {
    let calls = 0;
    const client = {
      connect: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('down'), { code: 'upstream_unavailable' });
      },
    };
    const stop = keepConnected(client, { minDelayMs: 100, maxDelayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(3);
    stop();
  });

  test('stop cancels pending retries', async () => {
    let calls = 0;
    const stop = keepConnected(
      {
        connect: async () => {
          calls++;
          throw new Error('down');
        },
      },
      { minDelayMs: 100, maxDelayMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });
});
