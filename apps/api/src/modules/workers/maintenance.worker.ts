import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { ApiError } from '../../common/errors.ts';
import { DB, type Db } from '../../db/client.ts';
import { commands, commandTargets, events, idempotencyKeys, lessons, outbox } from '../../db/schema.ts';
import { EventLog, Outbox } from '../events/event-log.ts';
import { LessonsService } from '../lessons/lessons.service.ts';
import { WORKERS_ENABLED } from './outbox.worker.ts';

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION = { idempotencyMs: DAY, outboxMs: DAY, eventsMs: 7 * DAY } as const;
const INTERVAL_MS = 1_000;
const PURGE_EVERY_MS = 60_000;
const OPEN = ['pending', 'sent', 'acknowledged'];

// Muddat va tozalash: eskirgan target'lar, vaqti tugagan darslar, eski yozuvlar.
@Injectable()
export class MaintenanceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #log = new Logger('MaintenanceWorker');
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #lastPurge: number | undefined;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(WORKERS_ENABLED) private readonly enabled: boolean,
    @Inject(LessonsService) private readonly lessons: LessonsService,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.#timer = setInterval(() => void this.#safeTick(), INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.#timer);
  }

  async tick(now: number): Promise<{ expiredTargets: number; endedLessons: number; purged: number }> {
    const expiredTargets = await this.#expire(now);
    const endedLessons = await this.#endOverdue(now);
    // Tozalash og'ir: daqiqada bir marta.
    let purged = 0;
    // Soat orqaga ketsa (now < oxirgi) ham tozalash to'xtab qolmaydi.
    const last = this.#lastPurge;
    if (last === undefined || now < last || now - last >= PURGE_EVERY_MS) {
      purged = await this.#purge(now);
      this.#lastPurge = now;
    }
    return { expiredTargets, endedLessons, purged };
  }

  // Shartli: receipt yoki dars tugashi bilan terminal bo'lgan target'ga tegilmaydi.
  async #expire(now: number): Promise<number> {
    const at = new Date(now);
    return this.db.transaction(async (tx) => {
      // Ochiq target'lar (partial indeks) → buyruq muddati; butun commands tarixi skanerlanmaydi.
      const expired = await tx
        .update(commandTargets)
        .set({ status: 'expired', updatedAt: at, finishedAt: at })
        .from(commands)
        .where(
          and(
            eq(commands.id, commandTargets.commandId),
            inArray(commandTargets.status, OPEN),
            lte(commands.expiresAt, at),
          ),
        )
        .returning({ commandId: commandTargets.commandId, deviceId: commandTargets.deviceId });
      if (expired.length === 0) return 0;
      const owners = await tx
        .select({ command: commands, roomId: lessons.roomId })
        .from(commands)
        .innerJoin(lessons, eq(lessons.id, commands.lessonId))
        .where(
          inArray(
            commands.id,
            expired.map((e) => e.commandId),
          ),
        );
      const byId = new Map(owners.map((o) => [o.command.id, o]));
      await this.events.lockRooms(
        tx,
        owners.map((o) => o.roomId),
      );
      const rooms = new Map<string, string>();
      for (const e of expired) {
        const owner = byId.get(e.commandId);
        if (!owner) continue;
        await this.events.append(tx, {
          organizationId: owner.command.organizationId,
          siteId: owner.command.siteId,
          roomId: owner.roomId,
          lessonId: owner.command.lessonId,
          type: 'command.target_updated',
          data: { commandId: e.commandId, deviceId: e.deviceId, status: 'expired' },
        });
        rooms.set(owner.roomId, owner.command.organizationId);
      }
      for (const [roomId, organizationId] of rooms) {
        await this.outbox.enqueue(tx, organizationId, 'notify.rooms', { roomIds: [roomId] });
      }
      return expired.length;
    });
  }

  async #endOverdue(now: number): Promise<number> {
    const overdue = await this.db
      .select({ id: lessons.id })
      .from(lessons)
      .where(and(eq(lessons.status, 'active'), lte(lessons.scheduledEndAt, new Date(now))));
    let ended = 0;
    for (const { id } of overdue) {
      try {
        await this.db.transaction((tx) =>
          this.lessons.endLesson(tx, id, 'timeout', null, `maintenance-${randomUUID()}`),
        );
        ended += 1;
      } catch (err) {
        // Shu orada teacher yopgan bo'lsa — o'tkazib yuboriladi.
        if (!(err instanceof ApiError && err.code === 'conflict')) throw err;
      }
    }
    return ended;
  }

  async #purge(now: number): Promise<number> {
    const keys = await this.db
      .delete(idempotencyKeys)
      .where(lte(idempotencyKeys.createdAt, new Date(now - RETENTION.idempotencyMs)))
      .returning({ key: idempotencyKeys.key });
    const done = await this.db
      .delete(outbox)
      .where(and(isNotNull(outbox.processedAt), lte(outbox.processedAt, new Date(now - RETENTION.outboxMs))))
      .returning({ id: outbox.id });
    const old = await this.db
      .delete(events)
      .where(lte(events.at, new Date(now - RETENTION.eventsMs)))
      .returning({ seq: events.seq });
    return keys.length + done.length + old.length;
  }

  async #safeTick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.tick(this.now());
    } catch (err) {
      this.#log.warn(`Maintenance tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#running = false;
    }
  }
}
