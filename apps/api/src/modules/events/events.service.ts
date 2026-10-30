import { Inject, Injectable } from '@nestjs/common';
import type { EventsResponse } from '@netschool/contracts';
import { and, asc, desc, eq, gt, max, min } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { isUuid } from '../../common/db-errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { commands, events, lessons, rooms } from '../../db/schema.ts';
import { CommandsService } from '../commands/commands.service.ts';
import { LessonsService } from '../lessons/lessons.service.ts';
import { RemoteSessionsService } from '../remote-sessions/remote-sessions.service.ts';
import { type Notifier, ROOM_NOTIFIER } from './notifier.ts';

const PAGE = 500;
const SNAPSHOT_COMMANDS = 50;

type EventRow = typeof events.$inferSelect;

// Xona holati: snapshot + cursor; reconnect'da cursor'dan keyingi voqealar (spec §9).
@Injectable()
export class EventsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(Access) private readonly access: Access,
    @Inject(LessonsService) private readonly lessons: LessonsService,
    @Inject(CommandsService) private readonly commands: CommandsService,
    @Inject(RemoteSessionsService) private readonly remoteSessions: RemoteSessionsService,
    @Inject(ROOM_NOTIFIER) private readonly notifier: Notifier,
  ) {}

  async read(
    ctx: RequestContext,
    roomId: string,
    after: number | undefined,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<EventsResponse> {
    const actor = this.access.actor(ctx);
    const [room] = isUuid(roomId)
      ? await this.db
          .select()
          .from(rooms)
          .where(and(eq(rooms.id, roomId), eq(rooms.organizationId, actor.organizationId)))
      : [];
    if (!room) return this.access.deny(ctx, 'lesson.read', { targetType: 'room', targetId: roomId });
    await this.access.require(
      ctx,
      'lesson.read',
      { organizationId: room.organizationId, siteId: room.siteId, roomId: room.id },
      { targetType: 'room', targetId: room.id },
    );
    if (after === undefined || (await this.#purgedPast(after))) return this.#snapshot(room.id);

    let page = await this.#page(room.id, after);
    if (page.length === 0 && waitSeconds > 0) {
      await this.notifier.wait(room.id, waitSeconds * 1000, signal);
      page = await this.#page(room.id, after);
    }
    const last = page.at(-1);
    return { cursor: String(last ? last.seq : after), resync: false, events: page.map(toEvent) };
  }

  // seq global va tozalash vaqt bo'yicha global: qolgan eng kichik seq'dan oldingi cursor voqea yo'qotgan bo'lishi mumkin.
  async #purgedPast(after: number): Promise<boolean> {
    const [row] = await this.db.select({ min: min(events.seq) }).from(events);
    const oldest = row?.min ?? null;
    return oldest === null ? after > 0 : after < Number(oldest) - 1;
  }

  async #page(roomId: string, after: number): Promise<EventRow[]> {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.roomId, roomId), gt(events.seq, after)))
      .orderBy(asc(events.seq))
      .limit(PAGE);
  }

  // Cursor snapshot'dan oldin olinadi: oraliqdagi voqea takrorlanishi mumkin, lekin yo'qolmaydi.
  async #snapshot(roomId: string): Promise<EventsResponse> {
    const [top] = await this.db
      .select({ max: max(events.seq) })
      .from(events)
      .where(eq(events.roomId, roomId));
    const cursor = String(top?.max ?? 0);
    const [lesson] = await this.db
      .select()
      .from(lessons)
      .where(and(eq(lessons.roomId, roomId), eq(lessons.status, 'active')));
    if (!lesson)
      return { cursor, resync: true, snapshot: { lesson: null, commands: [], remoteSessions: [] }, events: [] };
    const recent = await this.db
      .select({ id: commands.id })
      .from(commands)
      .where(eq(commands.lessonId, lesson.id))
      .orderBy(desc(commands.seq))
      .limit(SNAPSHOT_COMMANDS);
    const views = [];
    for (const c of recent.reverse()) views.push(await this.commands.view(this.db, c.id));
    return {
      cursor,
      resync: true,
      snapshot: {
        lesson: await this.lessons.view(this.db, lesson),
        commands: views,
        remoteSessions: await this.remoteSessions.openOfLesson(this.db, lesson.id),
      },
      events: [],
    };
  }
}

function toEvent(e: EventRow): EventsResponse['events'][number] {
  return {
    seq: String(e.seq),
    type: e.type as EventsResponse['events'][number]['type'],
    at: e.at.toISOString(),
    lessonId: e.lessonId,
    data: e.data as Record<string, unknown>,
  };
}
