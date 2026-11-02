import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { THUMBNAIL_SERVER_MIN_INTERVAL_MS, THUMBNAIL_TTL_MS } from '@netschool/domain';
import { CLOCK, type Clock } from '../../common/clock.ts';

const SWEEP_INTERVAL_MS = 10_000;

interface Frame {
  lessonId: string;
  jpeg: Buffer;
  seq: number;
  at: number;
}

// Har qurilmaning faqat oxirgi kadri, faqat xotirada (diskka, DB'ga, outbox'ga, auditga, logga yozilmaydi).
// Vaqt CLOCK'dan: testlar soatni o'zi boshqaradi.
@Injectable()
export class ThumbnailStore implements OnModuleInit, OnModuleDestroy {
  readonly #frames = new Map<string, Frame>();
  readonly #listeners = new Set<(deviceId: string, lessonId: string) => void>();
  #timer: NodeJS.Timeout | undefined;

  constructor(@Inject(CLOCK) private readonly now: Clock) {}

  onModuleInit(): void {
    this.#timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.#timer);
    this.#frames.clear();
  }

  put(deviceId: string, lessonId: string, jpeg: Buffer): 'stored' | 'too_fast' | 'not_jpeg' {
    // JPEG SOI: FF D8 FF.
    if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return 'not_jpeg';
    const at = this.now();
    const prev = this.#frames.get(deviceId);
    if (prev && prev.lessonId === lessonId && at - prev.at < THUMBNAIL_SERVER_MIN_INTERVAL_MS) return 'too_fast';
    this.#frames.set(deviceId, { lessonId, jpeg, seq: (prev?.seq ?? 0) + 1, at });
    for (const listener of this.#listeners) listener(deviceId, lessonId);
    return 'stored';
  }

  // Yangi saqlangan kadr haqida xabar (o'qituvchi oqimi); kadrning o'zi latest() orqali olinadi.
  onFrame(listener: (deviceId: string, lessonId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // TTL tashqarisidagi yoki boshqa dars uchun olingan kadr berilmaydi.
  latest(deviceId: string, lessonId: string): { jpeg: Buffer; seq: number; at: number } | null {
    const frame = this.#frames.get(deviceId);
    if (!frame || frame.lessonId !== lessonId || this.now() - frame.at > THUMBNAIL_TTL_MS) return null;
    return { jpeg: frame.jpeg, seq: frame.seq, at: frame.at };
  }

  sweep(): void {
    const now = this.now();
    for (const [deviceId, frame] of this.#frames) if (now - frame.at > THUMBNAIL_TTL_MS) this.#frames.delete(deviceId);
  }
}
