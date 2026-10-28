import { Inject, Injectable } from '@nestjs/common';
import type { Lesson, StartLessonRequest } from '@netschool/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUniqueViolation, isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import { Idempotency } from '../../common/idempotency.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { commands, commandTargets, devices, lessonDevices, lessons, rooms } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { EventLog, Outbox } from '../events/event-log.ts';

export type LessonRow = typeof lessons.$inferSelect;
export type EndReason = 'teacher' | 'admin' | 'timeout';

const DEFAULT_DURATION_MINUTES = 90;
const OPEN_STATUSES = ['pending', 'sent', 'acknowledged'];

@Injectable()
export class LessonsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(Idempotency) private readonly idempotency: Idempotency,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  async start(ctx: RequestContext, roomId: string, input: StartLessonRequest, key: string) {
    const actor = this.access.actor(ctx);
    const [room] = isUuid(roomId)
      ? await this.db
          .select()
          .from(rooms)
          .where(and(eq(rooms.id, roomId), eq(rooms.organizationId, actor.organizationId)))
      : [];
    if (!room) return this.access.deny(ctx, 'lesson.start', { targetType: 'room', targetId: roomId });
    await this.access.require(
      ctx,
      'lesson.start',
      { organizationId: room.organizationId, siteId: room.siteId, roomId: room.id },
      { targetType: 'room', targetId: room.id },
    );
    return this.idempotency.run(ctx, `POST /rooms/${room.id}/lessons`, key, input, 201, async (tx) => {
      const now = this.now();
      let lesson: LessonRow | undefined;
      try {
        [lesson] = await tx
          .insert(lessons)
          .values({
            organizationId: room.organizationId,
            siteId: room.siteId,
            roomId: room.id,
            teacherUserId: actor.userId,
            title: input.title ?? null,
            startedAt: new Date(now),
            scheduledEndAt: new Date(now + (input.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000),
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err)) throw new ApiError('conflict', 'Room already has an active lesson');
        throw err;
      }
      if (!lesson) throw new Error('lesson insert failed');
      const inRoom = await tx
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.roomId, room.id), isNull(devices.retiredAt)));
      // Boshqa faol darsdagi qurilma (masalan dars davomida ko'chirilgan) o'tkazib yuboriladi.
      const joined = inRoom.length
        ? await tx
            .insert(lessonDevices)
            .values(
              inRoom.map((d) => ({
                lessonId: lesson.id,
                deviceId: d.id,
                organizationId: room.organizationId,
                siteId: room.siteId,
                joinedAt: new Date(now),
              })),
            )
            .onConflictDoNothing()
            .returning({ deviceId: lessonDevices.deviceId })
        : [];
      const deviceIds = joined.map((j) => j.deviceId).sort();
      await this.events.append(tx, {
        organizationId: lesson.organizationId,
        siteId: lesson.siteId,
        roomId: lesson.roomId,
        lessonId: lesson.id,
        type: 'lesson.started',
        data: { teacherUserId: lesson.teacherUserId, deviceIds },
      });
      await this.#notify(tx, lesson, deviceIds);
      await this.#audit(tx, lesson, actor.userId, 'lesson.start', ctx.correlationId, { deviceCount: deviceIds.length });
      return this.#view(lesson, deviceIds);
    });
  }

  async active(ctx: RequestContext, roomId: string): Promise<Lesson | null> {
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
    const [lesson] = await this.db
      .select()
      .from(lessons)
      .where(and(eq(lessons.roomId, room.id), eq(lessons.status, 'active')));
    return lesson ? this.view(this.db, lesson) : null;
  }

  async get(ctx: RequestContext, lessonId: string): Promise<Lesson> {
    const lesson = await this.readable(ctx, lessonId, 'lesson.read');
    return this.view(this.db, lesson);
  }

  async end(ctx: RequestContext, lessonId: string, key: string) {
    const actor = this.access.actor(ctx);
    const lesson = await this.#find(ctx, lessonId, 'lesson.end');
    await this.access.require(
      ctx,
      'lesson.end',
      {
        organizationId: lesson.organizationId,
        siteId: lesson.siteId,
        roomId: lesson.roomId,
        ownerUserId: lesson.teacherUserId,
      },
      { targetType: 'lesson', targetId: lesson.id },
    );
    const reason: EndReason = actor.userId === lesson.teacherUserId ? 'teacher' : 'admin';
    return this.idempotency.run(ctx, `POST /lessons/${lesson.id}/end`, key, {}, 200, (tx) =>
      this.endLesson(tx, lesson.id, reason, actor.userId, ctx.correlationId),
    );
  }

  // Bitta tranzaksiyada: dars yopiladi, qurilmalar bo'shaydi, ochiq buyruq target'lari bekor qilinadi.
  async endLesson(tx: Db, lessonId: string, reason: EndReason, endedBy: string | null, correlationId: string) {
    const at = new Date(this.now());
    const [lesson] = await tx
      .update(lessons)
      .set({ status: 'ended', endedAt: at, endReason: reason, endedBy })
      .where(and(eq(lessons.id, lessonId), eq(lessons.status, 'active')))
      .returning();
    if (!lesson) throw new ApiError('conflict', 'Lesson has already ended');
    const released = await tx
      .update(lessonDevices)
      .set({ releasedAt: at })
      .where(and(eq(lessonDevices.lessonId, lesson.id), isNull(lessonDevices.releasedAt)))
      .returning({ deviceId: lessonDevices.deviceId });
    const lessonCommands = tx.select({ id: commands.id }).from(commands).where(eq(commands.lessonId, lesson.id));
    const cancelled = await tx
      .update(commandTargets)
      .set({ status: 'cancelled', updatedAt: at, finishedAt: at })
      .where(and(inArray(commandTargets.commandId, lessonCommands), inArray(commandTargets.status, OPEN_STATUSES)))
      .returning({ commandId: commandTargets.commandId });
    const deviceIds = released.map((r) => r.deviceId).sort();
    await this.events.append(tx, {
      organizationId: lesson.organizationId,
      siteId: lesson.siteId,
      roomId: lesson.roomId,
      lessonId: lesson.id,
      type: 'lesson.ended',
      data: { reason, cancelledTargets: cancelled.length },
    });
    await this.#notify(tx, lesson, deviceIds);
    await this.#audit(tx, lesson, endedBy, 'lesson.end', correlationId, { reason, cancelledTargets: cancelled.length });
    return this.view(tx, lesson);
  }

  // lesson.read yoki boshqa action uchun: topilmasa/begona — bir xil 403.
  async readable(ctx: RequestContext, lessonId: string, action: 'lesson.read' | 'command.read'): Promise<LessonRow> {
    const lesson = await this.#find(ctx, lessonId, action);
    await this.access.require(
      ctx,
      action,
      { organizationId: lesson.organizationId, siteId: lesson.siteId, roomId: lesson.roomId },
      { targetType: 'lesson', targetId: lesson.id },
    );
    return lesson;
  }

  async view(db: Db, lesson: LessonRow): Promise<Lesson> {
    const joined = await db
      .select({ deviceId: lessonDevices.deviceId })
      .from(lessonDevices)
      .where(eq(lessonDevices.lessonId, lesson.id));
    return this.#view(
      lesson,
      joined.map((j) => j.deviceId),
    );
  }

  async #find(ctx: RequestContext, lessonId: string, action: 'lesson.read' | 'lesson.end' | 'command.read') {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(lessonId)
      ? await this.db
          .select()
          .from(lessons)
          .where(and(eq(lessons.id, lessonId), eq(lessons.organizationId, actor.organizationId)))
      : [];
    return row ?? this.access.deny(ctx, action, { targetType: 'lesson', targetId: lessonId });
  }

  #view(lesson: LessonRow, deviceIds: string[]): Lesson {
    return {
      id: lesson.id,
      siteId: lesson.siteId,
      roomId: lesson.roomId,
      teacherUserId: lesson.teacherUserId,
      title: lesson.title,
      status: lesson.status as Lesson['status'],
      startedAt: lesson.startedAt.toISOString(),
      scheduledEndAt: lesson.scheduledEndAt.toISOString(),
      endedAt: lesson.endedAt?.toISOString() ?? null,
      endReason: (lesson.endReason as EndReason | null) ?? null,
      deviceIds: [...deviceIds].sort(),
    };
  }

  async #notify(tx: Db, lesson: LessonRow, deviceIds: string[]) {
    await this.outbox.enqueue(tx, lesson.organizationId, 'notify.rooms', { roomIds: [lesson.roomId] });
    if (deviceIds.length) await this.outbox.enqueue(tx, lesson.organizationId, 'notify.devices', { deviceIds });
  }

  #audit(
    tx: Db,
    lesson: LessonRow,
    actorUserId: string | null,
    action: string,
    correlationId: string,
    details: Record<string, unknown>,
  ) {
    return this.audit.write(
      tx,
      {
        organizationId: lesson.organizationId,
        siteId: lesson.siteId,
        actorUserId,
        action,
        targetType: 'lesson',
        targetId: lesson.id,
        result: 'succeeded',
        details,
      },
      correlationId,
    );
  }
}
