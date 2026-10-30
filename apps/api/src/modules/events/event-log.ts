import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import type { Db } from '../../db/client.ts';
import { events, outbox } from '../../db/schema.ts';

export type EventType =
  | 'lesson.started'
  | 'lesson.ended'
  | 'command.created'
  | 'command.target_updated'
  | 'remote_session.opened'
  | 'remote_session.closed';

export interface NewEvent {
  organizationId: string;
  siteId: string;
  roomId: string;
  lessonId: string | null;
  type: EventType;
  data: Record<string, unknown>;
}

// Advisory lock namespace (xona voqealari).
const ROOM_EVENTS_LOCK = 7_310_001;

// Xona voqealari jurnali (GET /events cursor manbai): mutatsiya bilan bitta tranzaksiyada.
// `seq` insert paytida beriladi, commit esa boshqa tartibda bo'lishi mumkin; xona lock'i commit'gacha
// ushlanadi, shuning uchun bir xonada seq tartibi commit tartibiga teng — cursor voqeani o'tkazib yubormaydi.
@Injectable()
export class EventLog {
  constructor(@Inject(CLOCK) private readonly now: Clock) {}

  // Bir nechta xonaga yozadigan tranzaksiya lock'larni oldindan, tartib bilan oladi (deadlock bo'lmasligi uchun).
  async lockRooms(tx: Db, roomIds: Iterable<string>): Promise<void> {
    for (const roomId of [...new Set(roomIds)].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROOM_EVENTS_LOCK}, hashtext(${roomId}))`);
    }
  }

  async append(tx: Db, event: NewEvent): Promise<void> {
    await this.lockRooms(tx, [event.roomId]);
    await tx.insert(events).values({ ...event, at: new Date(this.now()) });
  }
}

export type OutboxTopic = 'notify.devices' | 'notify.rooms' | 'remote.revoke';
export interface OutboxPayload {
  deviceIds?: string[];
  roomIds?: string[];
  sessionId?: string;
}

// Tashqi effektlar (uyg'otish, keyin MeshCentral) worker orqali, qayta urinish bilan.
@Injectable()
export class Outbox {
  #onKick: (() => void) | undefined;
  #onSessionsClosed: ((sessionIds: string[]) => void) | undefined;
  // Tranzaksiyada yopilgan masofaviy sessiyalar: navbatdagi kick() ularni uzatadi.
  readonly #closedSessions = new Set<string>();

  constructor(@Inject(CLOCK) private readonly now: Clock) {}

  async enqueue(tx: Db, organizationId: string, topic: OutboxTopic, payload: OutboxPayload): Promise<void> {
    const at = new Date(this.now());
    await tx.insert(outbox).values({ organizationId, topic, payload, createdAt: at, nextAttemptAt: at });
  }

  // Shoshilinch qatorlar (remote.revoke) yozilgan tranzaksiya commit bo'lgach chaqiriladi: worker intervalni kutmaydi.
  // Tranzaksiya ichida chaqirilmaydi — commit'gacha worker qatorni ko'rmaydi.
  // Yopilgan sessiyalar ham shu yerda uzatiladi: ularning gateway soketlari outbox tick'ini kutmaydi.
  kick(): void {
    if (this.#closedSessions.size > 0) {
      const ids = [...this.#closedSessions];
      this.#closedSessions.clear();
      this.#onSessionsClosed?.(ids);
    }
    this.#onKick?.();
  }

  // OutboxWorker o'zini ulaydi (modul sikli bo'lmasligi uchun xizmatlar worker'ni emas, Outbox'ni biladi).
  onKick(listener: () => void): void {
    this.#onKick = listener;
  }

  // closeRemoteSessions tranzaksiya ichida chaqiradi; commit'ni kick() bildiradi. Boshqa so'rovning kick'i id'ni
  // commit'dan oldin olishi mumkin — tinglovchi DB'da yopilganini tekshiradi va yopilmaganini qaytaradi.
  sessionsClosed(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) this.#closedSessions.add(id);
  }

  // RemoteSessionsService ulanadi (gateway soketlarini lokal uzadi).
  onSessionsClosed(listener: (sessionIds: string[]) => void): void {
    this.#onSessionsClosed = listener;
  }
}
