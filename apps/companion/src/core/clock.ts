import { uptime } from 'node:os';
import { performance } from 'node:perf_hooks';

// Cheklov muddatlari devor soatiga (`Date.now`) bog'lanmaydi: OS soati o'zgarsa lease uzaymasligi kerak (spec §10).
export interface MonotonicClock {
  // Jarayon ichidagi monoton vaqt (ms).
  nowMs(): number;
  // OS ishga tushganidan beri (ms): jarayon qayta ishga tushganda ham davom etadi.
  uptimeMs(): number;
  // Joriy boot'ning devor soatidagi vaqti: `Date.now() − uptime`. Boshqa boot ekanini aniqlash uchun.
  bootTimeMs(): number;
}

export interface ClockSources {
  perfNowMs(): number;
  uptimeSeconds(): number;
  wallMs(): number;
}

const realSources: ClockSources = {
  perfNowMs: () => performance.now(),
  uptimeSeconds: () => uptime(),
  wallMs: () => Date.now(),
};

export function createClock(src: ClockSources = realSources): MonotonicClock {
  return {
    nowMs: () => src.perfNowMs(),
    uptimeMs: () => src.uptimeSeconds() * 1000,
    bootTimeMs: () => src.wallMs() - src.uptimeSeconds() * 1000,
  };
}

export const systemClock: MonotonicClock = createClock();
