import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { DB, type Db } from '../../db/client.ts';
import { outbox } from '../../db/schema.ts';
import { Outbox, type OutboxPayload } from '../events/event-log.ts';
import { DEVICE_NOTIFIER, type Notifier, ROOM_NOTIFIER } from '../events/notifier.ts';
import { RemoteGateway } from '../remote-sessions/remote-gateway.ts';

export const WORKERS_ENABLED = Symbol('WORKERS_ENABLED');
export const OUTBOX_MAX_ATTEMPTS = 10;
const BATCH = 100;
// Bitta batch'da bir vaqtda bajariladigan handler'lar: osilgan revoke (≤ 10 s) qolgan qatorlarni ushlab turmaydi.
const CONCURRENCY = 16;
const INTERVAL_MS = 250;
const MAX_BACKOFF_MS = 60_000;
// Claim lease: shu muddatda natija yozilmasa (jarayon o'lgan) qator qayta olinadi.
const CLAIM_LEASE_MS = 30_000;
// Revoke claim lease ichida tugashi shart: osilib qolgan upstream chaqiruvi xato bo'lib qayta uriniladi.
export const REVOKE_TIMEOUT_MS = 10_000;

type Handler = (payload: OutboxPayload) => void | Promise<void>;
type Row = typeof outbox.$inferSelect;

// Gateway soketlari (1008) va principal yopiladi. Noma'lum yoki allaqachon yopilgan sessiya — muvaffaqiyat, gateway
// o'chiq — no-op. Vaqt tugasa broker'dagi revoke to'xtamaydi: keyingi urinish o'sha jarayondagi revoke'ni kutadi.
// Revoke'dan keyin yaratilgan principal (kechikkan aktivatsiya) reconciliation'da tozalanadi.
export async function revokeRemoteSession(
  gateway: RemoteGateway,
  sessionId: string,
  timeoutMs = REVOKE_TIMEOUT_MS,
): Promise<void> {
  if (!gateway.enabled) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Revoke timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([gateway.close(sessionId), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Outbox qatorlarini qayta urinish bilan bajaradi. Claim va bajarish ajratilgan: qatorlar qisqa tranzaksiyada
// `FOR UPDATE SKIP LOCKED` bilan olinib, claim lease (`next_attempt_at = now + 30 s`) bilan commit qilinadi; handler'lar
// tranzaksiyasiz ishlaydi (tashqi chaqiriqlar lock va ulanishni ushlamaydi). Jarayon claim'dan keyin o'lsa qator lease
// tugagach qayta olinadi — at-least-once, handler'lar idempotent bo'lishi shart. Har claim urinish hisoblanadi:
// har safar jarayonni yiqitadigan qator ham 10 urinishdan keyin to'xtaydi.
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
    @Inject(Outbox) outbox: Outbox,
    @Inject(RemoteGateway) gateway: RemoteGateway,
  ) {
    this.register('notify.devices', (p) => devices.wake(p.deviceIds ?? []));
    this.register('notify.rooms', (p) => rooms.wake(p.roomIds ?? []));
    this.register('remote.revoke', (p) => {
      if (!p.sessionId) throw new Error('remote.revoke without sessionId');
      return revokeRemoteSession(gateway, p.sessionId);
    });
    outbox.onKick(() => this.kick());
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
    const claimedUntil = new Date(now + CLAIM_LEASE_MS);
    const claimed = await this.#claim(now, claimedUntil);
    let processed = 0;
    let next = 0;
    // Pool: har yo'lak bo'shagach navbatdagi qatorni oladi; tick barcha boshlangan handler'lar tugagach qaytadi.
    const lane = async (): Promise<void> => {
      for (let row = claimed[next++]; row; row = claimed[next++]) {
        // Claim 100 tagacha qatorni qamraydi: lease tugagan bo'lsa qolganlarini boshqa tick qayta olgan bo'lishi
        // mumkin — natija yozilmaydi, ular lease tugagani uchun keyingi claim'da bajariladi.
        if (this.now() >= claimedUntil.getTime()) return;
        if (await this.#run(row, now, claimedUntil)) processed += 1;
      }
    };
    // Natija yozuvidagi DB xatosi ham boshqa yo'laklar tugashini kutadi, keyin tick xatosi bo'lib chiqadi.
    const lanes = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, lane));
    const failed = lanes.find((l) => l.status === 'rejected');
    if (failed) throw failed.reason;
    return processed;
  }

  // Qaytgan qatorlarda `attempts` — claim'dan oldingi qiymat.
  async #claim(now: number, claimedUntil: Date): Promise<Row[]> {
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
        .set({ attempts: sql`${outbox.attempts} + 1`, nextAttemptAt: claimedUntil })
        .where(
          inArray(
            outbox.id,
            due.map((r) => r.id),
          ),
        );
      return due;
    });
  }

  // Muvaffaqiyat har doim yoziladi (handler'lar idempotent). Xato esa faqat shu tick'ning claim'i hali amalda bo'lsa:
  // lease tugab qatorni boshqa tick olgan bo'lsa, kechikkan xato uning lease'ini qisqartirmaydi.
  async #run(row: Row, now: number, claimedUntil: Date): Promise<boolean> {
    try {
      const handler = this.#handlers.get(row.topic);
      if (!handler) throw new Error(`No handler for topic ${row.topic}`);
      await handler(row.payload as OutboxPayload);
      await this.db
        .update(outbox)
        .set({ processedAt: new Date(now) })
        .where(and(eq(outbox.id, row.id), isNull(outbox.processedAt)));
      return true;
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.db
        .update(outbox)
        .set({
          lastError: message.slice(0, 200),
          nextAttemptAt: new Date(now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** row.attempts)),
        })
        .where(and(eq(outbox.id, row.id), isNull(outbox.processedAt), eq(outbox.nextAttemptAt, claimedUntil)))
        .returning({ id: outbox.id });
      if (failed.length > 0 && attempts >= OUTBOX_MAX_ATTEMPTS)
        this.#log.error(`Outbox row ${row.id} parked after ${attempts} attempts`);
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
