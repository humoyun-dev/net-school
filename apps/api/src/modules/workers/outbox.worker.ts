import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, isNull, lt, lte } from 'drizzle-orm';
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

type Handler = (payload: OutboxPayload) => void | Promise<void>;

// Outbox qatorlarini qayta urinish bilan bajaradi. Qator lock bilan olinadi: parallel tick bir qatorni ikki marta olmaydi.
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #handlers = new Map<string, Handler>();
  readonly #log = new Logger('OutboxWorker');
  #timer: NodeJS.Timeout | undefined;
  #running = false;

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
    clearInterval(this.#timer);
  }

  async tick(now: number): Promise<number> {
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
      let processed = 0;
      for (const row of due) {
        try {
          const handler = this.#handlers.get(row.topic);
          if (!handler) throw new Error(`No handler for topic ${row.topic}`);
          await handler(row.payload as OutboxPayload);
          await tx
            .update(outbox)
            .set({ processedAt: new Date(now) })
            .where(eq(outbox.id, row.id));
          processed += 1;
        } catch (err) {
          const attempts = row.attempts + 1;
          const message = err instanceof Error ? err.message : String(err);
          await tx
            .update(outbox)
            .set({
              attempts,
              lastError: message.slice(0, 200),
              nextAttemptAt: new Date(now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** row.attempts)),
            })
            .where(eq(outbox.id, row.id));
          if (attempts >= OUTBOX_MAX_ATTEMPTS)
            this.#log.error(`Outbox row ${row.id} parked after ${attempts} attempts`);
        }
      }
      return processed;
    });
  }

  async #safeTick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.tick(this.now());
    } catch (err) {
      this.#log.warn(`Outbox tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#running = false;
    }
  }
}
