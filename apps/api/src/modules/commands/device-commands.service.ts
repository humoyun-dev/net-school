import { Inject, Injectable } from '@nestjs/common';
import type { DeviceCommand, ReceiptRequest } from '@netschool/contracts';
import { applyReceipt, type CommandType, type TargetStatus } from '@netschool/domain';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import { DB, type Db } from '../../db/client.ts';
import { commandReceipts, commands, commandTargets, lessons } from '../../db/schema.ts';
import type { AuthenticatedDevice } from '../devices/device-auth.guard.ts';
import { EventLog, Outbox } from '../events/event-log.ts';
import { DEVICE_NOTIFIER, type Notifier } from '../events/notifier.ts';

export const MAX_WAIT_SECONDS = 25;

@Injectable()
export class DeviceCommandsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(DEVICE_NOTIFIER) private readonly notifier: Notifier,
  ) {}

  // Long-poll: bo'sh bo'lsa `waitSeconds`gacha kutib bir marta qayta o'qiydi.
  async pull(device: AuthenticatedDevice, waitSeconds: number, signal?: AbortSignal): Promise<DeviceCommand[]> {
    const ready = await this.#take(device);
    if (ready.length > 0 || waitSeconds === 0) return ready;
    await this.notifier.wait(device.id, waitSeconds * 1000, signal);
    return this.#take(device);
  }

  // Muddati o'tmagan, faol darsdagi pending/sent target'lar; pending → sent. Ack kelguncha qayta yetkaziladi.
  async #take(device: AuthenticatedDevice): Promise<DeviceCommand[]> {
    const now = new Date(this.now());
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ target: commandTargets, command: commands, roomId: lessons.roomId })
        .from(commandTargets)
        .innerJoin(commands, eq(commands.id, commandTargets.commandId))
        .innerJoin(lessons, eq(lessons.id, commands.lessonId))
        .where(
          and(
            eq(commandTargets.deviceId, device.id),
            inArray(commandTargets.status, ['pending', 'sent']),
            gt(commands.expiresAt, now),
            eq(lessons.status, 'active'),
          ),
        )
        .orderBy(asc(commands.seq));
      const fresh = rows.filter((r) => r.target.status === 'pending');
      if (fresh.length > 0) {
        await tx
          .update(commandTargets)
          .set({ status: 'sent', sentAt: now, updatedAt: now })
          .where(
            and(
              eq(commandTargets.deviceId, device.id),
              eq(commandTargets.status, 'pending'),
              inArray(
                commandTargets.commandId,
                fresh.map((r) => r.command.id),
              ),
            ),
          );
        for (const r of fresh) await this.#updated(tx, r.command, r.roomId, device.id, 'sent');
      }
      return rows.map(({ command }) => ({
        commandId: command.id,
        sequence: String(command.seq),
        targetDeviceId: device.id,
        lessonId: command.lessonId,
        issuedAt: command.issuedAt.toISOString(),
        expiresAt: command.expiresAt.toISOString(),
        type: command.type as CommandType,
        payload: command.payload as Record<string, unknown>,
      }));
    });
  }

  async receipt(device: AuthenticatedDevice, commandId: string, input: ReceiptRequest): Promise<void> {
    if (!isUuid(commandId)) throw new ApiError('conflict', 'Unknown command target');
    const now = new Date(this.now());
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ target: commandTargets, command: commands, roomId: lessons.roomId })
        .from(commandTargets)
        .innerJoin(commands, eq(commands.id, commandTargets.commandId))
        .innerJoin(lessons, eq(lessons.id, commands.lessonId))
        .where(and(eq(commandTargets.commandId, commandId), eq(commandTargets.deviceId, device.id)));
      if (!row) throw new ApiError('conflict', 'Unknown command target');
      const current = row.target.status as TargetStatus;
      const transition = applyReceipt(current, input.status);
      if (transition.kind === 'noop') return;
      if (transition.kind === 'reject') throw new ApiError('conflict', `Target is already ${current}`);
      const finished = transition.to === 'succeeded' || transition.to === 'failed';
      // Shartli yangilash: maintenance (expiry) yoki dars tugashi bilan poygada eskirgan holat yozilmaydi.
      const updated = await tx
        .update(commandTargets)
        .set({
          status: transition.to,
          reason: input.status === 'failed' ? input.reason : null,
          updatedAt: now,
          ...(transition.to === 'acknowledged' ? { acknowledgedAt: now } : {}),
          ...(finished ? { finishedAt: now } : {}),
        })
        .where(
          and(
            eq(commandTargets.commandId, commandId),
            eq(commandTargets.deviceId, device.id),
            eq(commandTargets.status, current),
          ),
        )
        .returning({ status: commandTargets.status });
      if (updated.length !== 1) throw new ApiError('conflict', 'Target changed concurrently');
      await tx.insert(commandReceipts).values({
        commandId,
        deviceId: device.id,
        status: input.status,
        reason: input.status === 'failed' ? input.reason : null,
        receivedAt: now,
      });
      await this.#updated(tx, row.command, row.roomId, device.id, transition.to);
    });
  }

  async #updated(
    tx: Db,
    command: typeof commands.$inferSelect,
    roomId: string,
    deviceId: string,
    status: TargetStatus,
  ) {
    await this.events.append(tx, {
      organizationId: command.organizationId,
      siteId: command.siteId,
      roomId,
      lessonId: command.lessonId,
      type: 'command.target_updated',
      data: { commandId: command.id, deviceId, status },
    });
    await this.outbox.enqueue(tx, command.organizationId, 'notify.rooms', { roomIds: [roomId] });
  }
}
