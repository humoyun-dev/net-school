import { Inject, Injectable } from '@nestjs/common';
import type { Command, IssueCommandRequest } from '@netschool/contracts';
import {
  type CommandType,
  companionPresence,
  type FailureReason,
  gateTarget,
  type TargetStatus,
} from '@netschool/domain';
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import { Idempotency } from '../../common/idempotency.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { commands, commandTargets, deviceCapabilities, devices, lessonDevices, lessons } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { EventLog, Outbox } from '../events/event-log.ts';
import { LessonsService } from '../lessons/lessons.service.ts';

const DEFAULT_TTL_SECONDS = 60;
const STATUSES: TargetStatus[] = ['pending', 'sent', 'acknowledged', 'succeeded', 'failed', 'expired', 'cancelled'];

@Injectable()
export class CommandsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(Idempotency) private readonly idempotency: Idempotency,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(LessonsService) private readonly lessons: LessonsService,
  ) {}

  async issue(ctx: RequestContext, lessonId: string, input: IssueCommandRequest, key: string) {
    const actor = this.access.actor(ctx);
    const [lesson] = isUuid(lessonId)
      ? await this.db
          .select()
          .from(lessons)
          .where(and(eq(lessons.id, lessonId), eq(lessons.organizationId, actor.organizationId)))
      : [];
    if (!lesson) return this.access.deny(ctx, 'command.issue', { targetType: 'lesson', targetId: lessonId });
    await this.access.require(
      ctx,
      'command.issue',
      {
        organizationId: lesson.organizationId,
        siteId: lesson.siteId,
        roomId: lesson.roomId,
        ownerUserId: lesson.teacherUserId,
      },
      { targetType: 'lesson', targetId: lesson.id },
    );
    // Takroriy so'rov (masalan dars tugagach tarmoq qayta urinishi) a'zolik tekshiruvidan oldin saqlangan javobni oladi.
    const scope = `POST /lessons/${lesson.id}/commands`;
    const stored = await this.idempotency.replay<Command>(ctx, scope, key, input);
    if (stored) return stored;
    if (input.targetDeviceIds) {
      // Faqat shu darsdagi qurilmalar; tekshiruv tranzaksiyadan oldin, chunki rad etish auditi alohida yoziladi.
      const members = await this.#members(this.db, lesson.id);
      const outside = input.targetDeviceIds.find((id) => !members.includes(id));
      if (outside)
        return this.access.deny(ctx, 'command.issue', { targetType: 'device', targetId: outside }, lesson.siteId);
    }

    return this.idempotency.run(ctx, scope, key, input, 202, async (tx) => {
      const [live] = await tx
        .select({ status: lessons.status })
        .from(lessons)
        .where(eq(lessons.id, lesson.id))
        .for('share');
      if (live?.status !== 'active') throw new ApiError('conflict', 'Lesson has ended');
      const members = await this.#members(tx, lesson.id);
      const targetIds = (input.targetDeviceIds ?? members).filter((id) => members.includes(id));
      const now = this.now();
      const gates = await this.#gate(tx, input.type, targetIds, now);
      const pending = gates.filter((g) => g.status === 'pending');
      // Unlock xavfsiz yo'nalish: offline yoki qodir bo'lmagan sinf uchun ham istalgan holat yoziladi.
      const unlock = input.type === 'overlay.unlock';
      if (!unlock && pending.length === 0) throw new ApiError('capability_unavailable');
      if (!unlock && pending.every((g) => !g.online)) throw new ApiError('device_offline');

      const [command] = await tx
        .insert(commands)
        .values({
          organizationId: lesson.organizationId,
          siteId: lesson.siteId,
          lessonId: lesson.id,
          issuedBy: actor.userId,
          type: input.type,
          payload: input.payload,
          issuedAt: new Date(now),
          expiresAt: new Date(now + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000),
        })
        .returning();
      if (!command) throw new Error('command insert failed');
      await tx.insert(commandTargets).values(
        gates.map((g) => ({
          commandId: command.id,
          deviceId: g.deviceId,
          organizationId: lesson.organizationId,
          status: g.status,
          reason: g.status === 'failed' ? g.reason : null,
          updatedAt: new Date(now),
          finishedAt: g.status === 'failed' ? new Date(now) : null,
        })),
      );
      const pendingIds = pending.map((g) => g.deviceId).sort();
      if (input.type === 'overlay.lock') await applyOverlay(tx, lesson.id, pendingIds, true, command.seq);
      if (unlock) await applyOverlay(tx, lesson.id, targetIds, false, command.seq);
      await this.events.append(tx, {
        organizationId: lesson.organizationId,
        siteId: lesson.siteId,
        roomId: lesson.roomId,
        lessonId: lesson.id,
        type: 'command.created',
        data: { commandId: command.id, type: command.type, targets: gates.length, pending: pendingIds.length },
      });
      await this.outbox.enqueue(tx, lesson.organizationId, 'notify.devices', { deviceIds: pendingIds });
      await this.outbox.enqueue(tx, lesson.organizationId, 'notify.rooms', { roomIds: [lesson.roomId] });
      await this.audit.write(
        tx,
        {
          organizationId: lesson.organizationId,
          siteId: lesson.siteId,
          actorUserId: actor.userId,
          action: 'command.issue',
          targetType: 'command',
          targetId: command.id,
          result: 'succeeded',
          details: { type: command.type, targetCount: gates.length },
        },
        ctx.correlationId,
      );
      return this.view(tx, command.id);
    });
  }

  async get(ctx: RequestContext, commandId: string): Promise<Command> {
    const actor = this.access.actor(ctx);
    const [command] = isUuid(commandId)
      ? await this.db
          .select({ id: commands.id, lessonId: commands.lessonId })
          .from(commands)
          .where(and(eq(commands.id, commandId), eq(commands.organizationId, actor.organizationId)))
      : [];
    if (!command) return this.access.deny(ctx, 'command.read', { targetType: 'command', targetId: commandId });
    await this.lessons.readable(ctx, command.lessonId, 'command.read');
    return this.view(this.db, command.id);
  }

  // Har target alohida; summary har holat sonini beradi (umumiy "success" yo'q).
  async view(db: Db, commandId: string): Promise<Command> {
    const [command] = await db.select().from(commands).where(eq(commands.id, commandId));
    if (!command) throw new Error('command missing');
    const targets = await db
      .select()
      .from(commandTargets)
      .where(eq(commandTargets.commandId, command.id))
      .orderBy(asc(commandTargets.deviceId));
    const summary = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TargetStatus, number>;
    for (const t of targets) summary[t.status as TargetStatus] += 1;
    return {
      id: command.id,
      lessonId: command.lessonId,
      type: command.type as CommandType,
      sequence: String(command.seq),
      issuedAt: command.issuedAt.toISOString(),
      expiresAt: command.expiresAt.toISOString(),
      targets: targets.map((t) => ({
        deviceId: t.deviceId,
        status: t.status as TargetStatus,
        reason: (t.reason as FailureReason | null) ?? null,
        updatedAt: t.updatedAt.toISOString(),
      })),
      summary,
    };
  }

  async #members(db: Db, lessonId: string): Promise<string[]> {
    const rows = await db
      .select({ deviceId: lessonDevices.deviceId })
      .from(lessonDevices)
      .where(and(eq(lessonDevices.lessonId, lessonId), isNull(lessonDevices.releasedAt)));
    return rows.map((r) => r.deviceId);
  }

  async #gate(db: Db, type: CommandType, deviceIds: string[], now: number) {
    if (deviceIds.length === 0) return [];
    const rows = await db
      .select({ id: devices.id, lastHeartbeatAt: devices.lastHeartbeatAt, report: deviceCapabilities.report })
      .from(devices)
      .leftJoin(deviceCapabilities, eq(deviceCapabilities.deviceId, devices.id))
      .where(inArray(devices.id, deviceIds));
    return rows.map((r) => {
      const caps = (r.report as { capabilities?: Record<string, { state: string }> } | null)?.capabilities ?? null;
      const online = companionPresence(r.lastHeartbeatAt?.getTime() ?? null, now) === 'online';
      return { deviceId: r.id, online, ...gateTarget(type, caps) };
    });
  }
}

// Istalgan overlay holati (heartbeat lease shu qiymatni qaytaradi, spec §10). Faqat yangiroq seq yozadi:
// parallel lock/unlock tranzaksiyalari tartibsiz commit bo'lsa ham eski buyruq yangisini bosib ketmaydi.
export async function applyOverlay(tx: Db, lessonId: string, deviceIds: string[], locked: boolean, seq: number) {
  if (deviceIds.length === 0) return;
  await tx
    .update(lessonDevices)
    .set({ overlayLocked: locked, overlaySeq: seq })
    .where(
      and(
        eq(lessonDevices.lessonId, lessonId),
        inArray(lessonDevices.deviceId, deviceIds),
        or(isNull(lessonDevices.overlaySeq), lt(lessonDevices.overlaySeq, seq)),
      ),
    );
}
