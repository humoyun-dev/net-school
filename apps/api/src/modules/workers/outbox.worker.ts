import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, lte } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { DB, type Db } from '../../db/client.ts';
import { outbox } from '../../db/schema.ts';
import type { OutboxPayload } from '../events/event-log.ts';
import { DEVICE_NOTIFIER, type Notifier, ROOM_NOTIFIER } from '../events/notifier.ts';

export const WORKERS_ENABLED = Symbol('WORKERS_ENABLED');
export const OUTBOX_MAX_ATTEMPTS = 10;
const BATCH = 100;
const INTERVAL_MS = 250;
const MAX_BACKOFF_MS = 60_000;
// Claim lease: shu muddatda natija yozilmasa (jarayon o'lgan) qator qayta olinadi.
const CLAIM_LEASE_MS = 30_000;

type Handler = (payload: OutboxPayload) => void | Promise<void>;
type Row = typeof outbox.$inferSelect;

// Outbox qatorlarini qayta urinish bilan bajaradi. Claim va bajarish ajratilgan: qatorlar qisqa tranzaksiyada
// `FOR UPDATE SKIP LOCKED` bilan olinib, claim lease (`next_attempt_at = now + 30 s`) bilan commit qilinadi; handler'lar
// tranzaksiyasiz ishlaydi (tashqi chaqiriqlar lock va ulanishni ushlamaydi). Jarayon claim'dan keyin o'lsa qator lease
// tugagach qayta olinadi — at-least-once, handler'lar idempotent bo'lishi shart.
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #handlers = new Map<string, Handler>();
  readonly #log = new Logger('OutboxWorker');
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #kicked = false;
  #stopped = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(WORKERS_ENABLED) private readonly enabled: boolean,
    @Inject(DEVICE_NOTIFIER) devices: Notifier,
    @Inject(ROOM_NOTIFIER) rooms: Notifier,
  ) {
    this.register('notify.devices', (p) => devices.wake(p.deviceIds ?? []));
    this.register('notify.rooms', (p) => rooms.wake(p.roomIds ?? []));
  }

  register(topic: string, handler: Handler): void {
    this.#handlers.set(topic, handler);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    // 250 ms: yetkazish kechikishi ack p95 ≤1 s maqsadi ichida (spec §11).
    this.#timer = setInterval(() => void this.#safeTick(), INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
  }

  // Outbox yozgan tranzaksiya commit bo'lgach chaqiriladi: intervalni kutmasdan tick. Ishlayotgan tick bilan
  // ustma-ust tushmaydi, lekin yo'qolmaydi — u tugagach yana bir tick bajariladi.
  kick(): void {
    if (!this.enabled || this.#stopped) return;
    this.#kicked = true;
    void this.#safeTick();
  }

  async tick(now: number): Promise<number> {
    const claimed = await this.#claim(now);
    let processed = 0;
    for (const row of claimed) {
      if (await this.#run(row, now)) processed += 1;
    }
    return processed;
  }

  async #claim(now: number): Promise<Row[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(outbox)
        .where(
          and(
            isNull(outbox.processedAt),
            lte(outbox.nextAttemptAt, new Date(now)),
            lt(outbox.attempts, OUTBOX_MAX_ATTEMPTS),
          ),
        )
        .orderBy(asc(outbox.id))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      if (due.length === 0) return due;
      await tx
        .update(outbox)
        .set({ nextAttemptAt: new Date(now + CLAIM_LEASE_MS) })
        .where(
          inArray(
            outbox.id,
            due.map((r) => r.id),
          ),
        );
      return due;
    });
  }

  // Natija shartli: lease tugab qatorni boshqa tick olib bajargan bo'lsa, kechikkan natija uni qayta ochmaydi.
  async #run(row: Row, now: number): Promise<boolean> {
    const pending = and(eq(outbox.id, row.id), isNull(outbox.processedAt));
    try {
      const handler = this.#handlers.get(row.topic);
      if (!handler) throw new Error(`No handler for topic ${row.topic}`);
      await handler(row.payload as OutboxPayload);
      await this.db
        .update(outbox)
        .set({ processedAt: new Date(now) })
        .where(pending);
      return true;
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(outbox)
        .set({
          attempts,
          lastError: message.slice(0, 200),
          nextAttemptAt: new Date(now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** row.attempts)),
        })
        .where(pending);
      if (attempts >= OUTBOX_MAX_ATTEMPTS) this.#log.error(`Outbox row ${row.id} parked after ${attempts} attempts`);
      return false;
    }
  }

  async #safeTick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      do {
        this.#kicked = false;
        try {
          await this.tick(this.now());
        } catch (err) {
          this.#log.warn(`Outbox tick failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } while (this.#kicked && !this.#stopped);
    } finally {
      this.#running = false;
    }
  }
}
