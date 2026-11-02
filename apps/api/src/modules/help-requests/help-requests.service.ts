import { Inject, Injectable } from '@nestjs/common';
import type { HelpRequest } from '@netschool/contracts';
import type { HelpClearReason } from '@netschool/domain';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { devices, helpRequests, lessonDevices, lessons } from '../../db/schema.ts';
import type { AuthenticatedDevice } from '../devices/device-auth.guard.ts';
import { EventLog, Outbox } from '../events/event-log.ts';

type HelpRow = typeof helpRequests.$inferSelect;

export type HelpScope = { lessonId: string; deviceId?: string };

// Yopilgan qator: event va uyg'otish uchun kerakli maydonlar (announceCleared).
export interface ClearedHelp {
  id: string;
  organizationId: string;
  siteId: string;
  roomId: string;
  lessonId: string;
  deviceId: string;
  reason: HelpClearReason;
}

function toHelpRequest(r: HelpRow): HelpRequest {
  return {
    id: r.id,
    lessonId: r.lessonId,
    deviceId: r.deviceId,
    raisedAt: r.raisedAt.toISOString(),
    clearedAt: r.clearedAt?.toISOString() ?? null,
    clearReason: (r.clearReason as HelpClearReason | null) ?? null,
  };
}

// Qo'l ko'tarish: matnsiz, bir (dars, qurilma) uchun eng ko'pi bitta ochiq so'rov. Faqat events (audit yo'q).
// Lock tartibi (ADR 0008): avval qatorlar (dars, a'zolik, help), keyin xona lock'i (EventLog).
@Injectable()
export class HelpRequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  // Qurilmaning faol darsida; ochiq so'rov bo'lsa o'sha qaytadi va yangi event yozilmaydi.
  async raise(device: AuthenticatedDevice): Promise<HelpRequest> {
    const [joined] = await this.db
      .select({ lessonId: lessonDevices.lessonId })
      .from(lessonDevices)
      .where(and(eq(lessonDevices.deviceId, device.id), isNull(lessonDevices.releasedAt)));
    if (!joined) throw new ApiError('conflict', 'Device is not in an active lesson');
    return this.db.transaction(async (tx) => {
      // Dars FOR SHARE: endLesson'ning UPDATE'i commit'gacha kutadi, shuning uchun yopilgan darsga so'rov yozilmaydi,
      // yozilgani esa endLesson'ning clearOpen'ida ko'rinadi.
      const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, joined.lessonId)).for('share');
      if (lesson?.status !== 'active') throw new ApiError('conflict', 'Lesson has ended');
      // A'zolik qatori ham: qurilma chiqishi (releasedAt UPDATE) shu so'rovni ko'rib yopadi.
      const [member] = await tx
        .select({ deviceId: lessonDevices.deviceId })
        .from(lessonDevices)
        .innerJoin(devices, eq(devices.id, lessonDevices.deviceId))
        .where(
          and(
            eq(lessonDevices.lessonId, lesson.id),
            eq(lessonDevices.deviceId, device.id),
            isNull(lessonDevices.releasedAt),
            isNull(devices.retiredAt),
          ),
        )
        .for('share', { of: lessonDevices });
      if (!member) throw new ApiError('conflict', 'Device has left the lesson');
      const [created] = await tx
        .insert(helpRequests)
        .values({
          organizationId: lesson.organizationId,
          siteId: lesson.siteId,
          roomId: lesson.roomId,
          lessonId: lesson.id,
          deviceId: device.id,
          raisedAt: new Date(this.now()),
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        // Parallel so'rov yozgan (commit bo'lgan): ochiq qator o'sha.
        const [existing] = await tx
          .select()
          .from(helpRequests)
          .where(
            and(
              eq(helpRequests.lessonId, lesson.id),
              eq(helpRequests.deviceId, device.id),
              isNull(helpRequests.clearedAt),
            ),
          );
        if (!existing) throw new Error('open help request missing');
        return toHelpRequest(existing);
      }
      await this.events.append(tx, {
        organizationId: lesson.organizationId,
        siteId: lesson.siteId,
        roomId: lesson.roomId,
        lessonId: lesson.id,
        type: 'help_request.raised',
        data: { helpRequestId: created.id, deviceId: device.id },
      });
      await this.outbox.enqueue(tx, lesson.organizationId, 'notify.rooms', { roomIds: [lesson.roomId] });
      return toHelpRequest(created);
    });
  }

  // Qurilma o'z ochiq so'rovini qaytarib oladi; so'rov bo'lmasa no-op.
  async withdraw(device: AuthenticatedDevice): Promise<void> {
    await this.db.transaction((tx) =>
      this.#close(tx, and(eq(helpRequests.deviceId, device.id), isNull(helpRequests.clearedAt)), 'device', null),
    );
  }

  // Dars egasi yoki site/org admin (`help.clear`). Allaqachon yopilgan so'rov o'zgarmaydi.
  // Topilmagan yoki begona so'rov — bir xil audit qilingan 403.
  async clear(ctx: RequestContext, helpRequestId: string): Promise<void> {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(helpRequestId)
      ? await this.db
          .select({ help: helpRequests, teacherUserId: lessons.teacherUserId })
          .from(helpRequests)
          .innerJoin(lessons, eq(lessons.id, helpRequests.lessonId))
          .where(and(eq(helpRequests.id, helpRequestId), eq(helpRequests.organizationId, actor.organizationId)))
      : [];
    const on = { targetType: 'help_request', targetId: helpRequestId };
    if (!row) return this.access.deny(ctx, 'help.clear', on);
    await this.access.require(
      ctx,
      'help.clear',
      {
        organizationId: row.help.organizationId,
        siteId: row.help.siteId,
        roomId: row.help.roomId,
        ownerUserId: row.teacherUserId,
      },
      on,
    );
    await this.db.transaction((tx) =>
      this.#close(tx, and(eq(helpRequests.id, row.help.id), isNull(helpRequests.clearedAt)), 'teacher', actor.userId),
    );
  }

  // Chaqiruvchining tranzaksiyasida: faqat qator lock'i (FOR UPDATE, id tartibida) va UPDATE; xona lock'i ham,
  // event ham yo'q. Chaqiruvchi avval boshqa qator lock'larini (closeRemoteSessions) oladi, keyin announceCleared
  // chaqiradi (ADR 0008: hamma qator lock'lari xona lock'idan oldin, aks holda sessiya yopilishi bilan deadlock).
  async clearOpen(
    tx: Db,
    scope: HelpScope,
    reason: Extract<HelpClearReason, 'lesson_ended' | 'device_left'>,
    clearedBy: string | null,
  ): Promise<ClearedHelp[]> {
    const where = and(
      eq(helpRequests.lessonId, scope.lessonId),
      scope.deviceId ? eq(helpRequests.deviceId, scope.deviceId) : undefined,
      isNull(helpRequests.clearedAt),
    );
    return this.#release(tx, where, reason, clearedBy);
  }

  // Xona lock'i ushlangandan keyin: har yopilgan so'rov uchun bitta event va xonalarni uyg'otish.
  async announceCleared(tx: Db, cleared: ClearedHelp[]): Promise<void> {
    if (cleared.length === 0) return;
    await this.events.lockRooms(
      tx,
      cleared.map((r) => r.roomId),
    );
    const rooms = new Map<string, Set<string>>();
    for (const r of cleared) {
      await this.events.append(tx, {
        organizationId: r.organizationId,
        siteId: r.siteId,
        roomId: r.roomId,
        lessonId: r.lessonId,
        type: 'help_request.cleared',
        data: { helpRequestId: r.id, deviceId: r.deviceId, reason: r.reason },
      });
      rooms.set(r.organizationId, (rooms.get(r.organizationId) ?? new Set()).add(r.roomId));
    }
    for (const [organizationId, roomIds] of rooms) {
      await this.outbox.enqueue(tx, organizationId, 'notify.rooms', { roomIds: [...roomIds].sort() });
    }
  }

  // Dars ochiq so'rovlari, ko'tarilgan vaqt bo'yicha: events snapshot'i uchun.
  async openOfLesson(db: Db, lessonId: string): Promise<HelpRequest[]> {
    const rows = await db
      .select()
      .from(helpRequests)
      .where(and(eq(helpRequests.lessonId, lessonId), isNull(helpRequests.clearedAt)))
      .orderBy(asc(helpRequests.raisedAt), asc(helpRequests.id));
    return rows.map(toHelpRequest);
  }

  // Heartbeat: qurilmaning shu darsdagi ochiq so'rovi.
  async openOfDevice(db: Db, lessonId: string, deviceId: string): Promise<{ id: string; raisedAt: string } | null> {
    const [row] = await db
      .select({ id: helpRequests.id, raisedAt: helpRequests.raisedAt })
      .from(helpRequests)
      .where(
        and(eq(helpRequests.lessonId, lessonId), eq(helpRequests.deviceId, deviceId), isNull(helpRequests.clearedAt)),
      );
    return row ? { id: row.id, raisedAt: row.raisedAt.toISOString() } : null;
  }

  // Qator lock'i, keyin xona lock'i: faqat boshqa qator lock'i olmaydigan chaqiruvchilar (withdraw, clear).
  async #close(tx: Db, where: SQL | undefined, reason: HelpClearReason, clearedBy: string | null): Promise<void> {
    await this.announceCleared(tx, await this.#release(tx, where, reason, clearedBy));
  }

  // Qatorlar id tartibida qulflanadi va yopiladi. READ COMMITTED: kutishdan keyin allaqachon yopilgan qator tushmaydi.
  async #release(
    tx: Db,
    where: SQL | undefined,
    reason: HelpClearReason,
    clearedBy: string | null,
  ): Promise<ClearedHelp[]> {
    const open = await tx.select().from(helpRequests).where(where).orderBy(asc(helpRequests.id)).for('update');
    if (open.length === 0) return [];
    const at = new Date(this.now());
    await tx
      .update(helpRequests)
      .set({ clearedAt: at, clearReason: reason, clearedBy })
      .where(
        inArray(
          helpRequests.id,
          open.map((r) => r.id),
        ),
      );
    return open.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      siteId: r.siteId,
      roomId: r.roomId,
      lessonId: r.lessonId,
      deviceId: r.deviceId,
      reason,
    }));
  }
}
