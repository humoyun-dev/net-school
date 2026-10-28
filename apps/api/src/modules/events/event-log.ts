import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock.ts';
import type { Db } from '../../db/client.ts';
import { events, outbox } from '../../db/schema.ts';

export type EventType = 'lesson.started' | 'lesson.ended' | 'command.created' | 'command.target_updated';

export interface NewEvent {
  organizationId: string;
  siteId: string;
  roomId: string;
  lessonId: string | null;
  type: EventType;
  data: Record<string, unknown>;
}

// Xona voqealari jurnali (GET /events cursor manbai): mutatsiya bilan bitta tranzaksiyada.
@Injectable()
export class EventLog {
  constructor(@Inject(CLOCK) private readonly now: Clock) {}

  async append(tx: Db, event: NewEvent): Promise<void> {
    await tx.insert(events).values({ ...event, at: new Date(this.now()) });
  }
}

export type OutboxTopic = 'notify.devices' | 'notify.rooms';
export interface OutboxPayload {
  deviceIds?: string[];
  roomIds?: string[];
}

// Tashqi effektlar (uyg'otish, keyin MeshCentral) worker orqali, qayta urinish bilan.
@Injectable()
export class Outbox {
  constructor(@Inject(CLOCK) private readonly now: Clock) {}

  async enqueue(tx: Db, organizationId: string, topic: OutboxTopic, payload: OutboxPayload): Promise<void> {
    const at = new Date(this.now());
    await tx.insert(outbox).values({ organizationId, topic, payload, createdAt: at, nextAttemptAt: at });
  }
}
