import { Inject, Injectable } from '@nestjs/common';
import type { CapabilityReport, Device } from '@netschool/contracts';
import { companionPresence } from '@netschool/domain';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { API_CONFIG, type ApiConfig } from '../../config/config.ts';
import { DB, type Db } from '../../db/client.ts';
import {
  commands,
  commandTargets,
  deviceCapabilities,
  devices,
  lessonDevices,
  lessons,
  meshBindings,
  rooms,
  sites,
} from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { EventLog, Outbox } from '../events/event-log.ts';
import { closeRemoteSessions } from '../remote-sessions/closing.ts';
import { DEVICE_MANAGEMENT, type DeviceManagementFactory, requirePort } from './mesh.ts';

export type DeviceRow = typeof devices.$inferSelect;
export type DeviceListScope = { siteId: string } | { roomId: string };

@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DEVICE_MANAGEMENT) private readonly factory: DeviceManagementFactory | null,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
  ) {}

  async list(ctx: RequestContext, scope: DeviceListScope): Promise<Device[]> {
    const actor = this.access.actor(ctx);
    let where: ReturnType<typeof eq>;
    let siteId: string;
    if ('roomId' in scope) {
      const [room] = isUuid(scope.roomId)
        ? await this.db
            .select()
            .from(rooms)
            .where(and(eq(rooms.id, scope.roomId), eq(rooms.organizationId, actor.organizationId)))
        : [];
      if (!room) return this.access.deny(ctx, 'device.read', { targetType: 'room', targetId: scope.roomId });
      await this.access.require(
        ctx,
        'device.read',
        { organizationId: room.organizationId, siteId: room.siteId, roomId: room.id },
        { targetType: 'room', targetId: room.id },
      );
      where = eq(devices.roomId, room.id);
      siteId = room.siteId;
    } else {
      const [site] = isUuid(scope.siteId)
        ? await this.db
            .select()
            .from(sites)
            .where(and(eq(sites.id, scope.siteId), eq(sites.organizationId, actor.organizationId)))
        : [];
      if (!site) return this.access.deny(ctx, 'device.read', { targetType: 'site', targetId: scope.siteId });
      await this.access.require(
        ctx,
        'device.read',
        { organizationId: site.organizationId, siteId: site.id },
        { targetType: 'site', targetId: site.id },
      );
      where = eq(devices.siteId, site.id);
      siteId = site.id;
    }
    const rows = await this.db
      .select({ device: devices, report: deviceCapabilities.report, meshNodeId: meshBindings.meshNodeId })
      .from(devices)
      .leftJoin(deviceCapabilities, eq(deviceCapabilities.deviceId, devices.id))
      .leftJoin(meshBindings, eq(meshBindings.deviceId, devices.id))
      .where(and(where, isNull(devices.retiredAt)))
      .orderBy(asc(devices.hostname), asc(devices.id));
    const agents = await this.#agentStates(
      siteId,
      rows.some((r) => r.meshNodeId !== null),
    );
    return rows.map((r) =>
      this.present(
        r.device,
        (r.report as CapabilityReport | null) ?? null,
        r.meshNodeId === null ? 'unbound' : agents ? (agents.get(r.meshNodeId) ? 'online' : 'offline') : 'unknown',
      ),
    );
  }

  // MeshAgent holati so'rov paytida adapterdan; MeshCentral javob bermasa ro'yxat baribir qaytadi (unknown).
  async #agentStates(siteId: string, anyBound: boolean): Promise<Map<string, boolean> | null> {
    if (!anyBound) return null;
    const [site] = await this.db.select().from(sites).where(eq(sites.id, siteId));
    if (!site) return null;
    try {
      const { port } = requirePort(this.factory, this.config.meshInstanceId, site);
      const snapshots = await port.listDevices(site.id);
      return new Map(snapshots.map((s) => [s.upstream.meshNodeId, s.agentOnline]));
    } catch {
      return null;
    }
  }

  async assignRoom(ctx: RequestContext, deviceId: string, roomId: string | null): Promise<Device> {
    const device = await this.manageable(ctx, deviceId);
    if (roomId !== null) {
      const [room] = isUuid(roomId)
        ? await this.db
            .select({ id: rooms.id })
            .from(rooms)
            .where(and(eq(rooms.id, roomId), eq(rooms.siteId, device.siteId)))
        : [];
      if (!room) return this.access.deny(ctx, 'device.manage', { targetType: 'room', targetId: roomId }, device.siteId);
    }
    const assigned = await this.db.transaction(async (tx) => {
      const [row] = await tx.update(devices).set({ roomId }).where(eq(devices.id, device.id)).returning();
      if (!row) throw new Error('device update failed');
      if (roomId !== device.roomId) await this.#leaveLesson(tx, ctx, device.id);
      await this.ok(tx, ctx, 'device.assign_room', row, { roomId, previousRoomId: device.roomId });
      const [caps] = await tx.select().from(deviceCapabilities).where(eq(deviceCapabilities.deviceId, row.id));
      const [binding] = await tx.select().from(meshBindings).where(eq(meshBindings.deviceId, row.id));
      return this.present(row, (caps?.report as CapabilityReport | undefined) ?? null, binding ? 'unknown' : 'unbound');
    });
    this.outbox.kick();
    return assigned;
  }

  // Qurilma identity'si bekor qilinadi: imzolangan so'rovlar rad, MeshAgent bog'lanishi o'chiriladi.
  async retire(ctx: RequestContext, deviceId: string): Promise<void> {
    const device = await this.manageable(ctx, deviceId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(devices)
        .set({ retiredAt: new Date(this.now()) })
        .where(eq(devices.id, device.id));
      await tx.delete(meshBindings).where(eq(meshBindings.deviceId, device.id));
      await this.#leaveLesson(tx, ctx, device.id);
      await this.ok(tx, ctx, 'device.retire', device);
    });
    this.outbox.kick();
  }

  // Faol (retired emas) qurilma + device.manage; topilmasa ham bir xil 403.
  async manageable(ctx: RequestContext, deviceId: string): Promise<DeviceRow> {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(deviceId)
      ? await this.db
          .select()
          .from(devices)
          .where(
            and(eq(devices.id, deviceId), eq(devices.organizationId, actor.organizationId), isNull(devices.retiredAt)),
          )
      : [];
    if (!row) return this.access.deny(ctx, 'device.manage', { targetType: 'device', targetId: deviceId });
    await this.access.require(
      ctx,
      'device.manage',
      { organizationId: row.organizationId, siteId: row.siteId, roomId: row.roomId ?? undefined },
      { targetType: 'device', targetId: row.id },
    );
    return row;
  }

  // Xonadan chiqqan yoki retire qilingan qurilma eski xona darsida qolmaydi: a'zolik tugaydi, masofaviy sessiyalari
  // yopiladi, ochiq target'lar bekor. Chaqiruvchi commit'dan keyin Outbox.kick() qiladi (remote.revoke).
  async #leaveLesson(tx: Db, ctx: RequestContext, deviceId: string): Promise<void> {
    const at = new Date(this.now());
    const left = await tx
      .update(lessonDevices)
      .set({ releasedAt: at })
      .where(and(eq(lessonDevices.deviceId, deviceId), isNull(lessonDevices.releasedAt)))
      .returning({ lessonId: lessonDevices.lessonId });
    // Xona voqealaridan oldin: sessiya qatorlari xona lock'idan oldin olinadi (closing.ts dagi lock tartibi).
    await closeRemoteSessions(tx, { deviceId }, 'device_left', at, this.access.actor(ctx).userId, ctx.correlationId, {
      events: this.events,
      outbox: this.outbox,
      audit: this.audit,
    });
    for (const { lessonId } of left) {
      const [lesson] = await tx.select().from(lessons).where(eq(lessons.id, lessonId));
      if (!lesson) continue;
      const lessonCommands = tx.select({ id: commands.id }).from(commands).where(eq(commands.lessonId, lessonId));
      const cancelled = await tx
        .update(commandTargets)
        .set({ status: 'cancelled', updatedAt: at, finishedAt: at })
        .where(
          and(
            eq(commandTargets.deviceId, deviceId),
            inArray(commandTargets.commandId, lessonCommands),
            inArray(commandTargets.status, ['pending', 'sent', 'acknowledged']),
          ),
        )
        .returning({ commandId: commandTargets.commandId });
      for (const c of cancelled) {
        await this.events.append(tx, {
          organizationId: lesson.organizationId,
          siteId: lesson.siteId,
          roomId: lesson.roomId,
          lessonId,
          type: 'command.target_updated',
          data: { commandId: c.commandId, deviceId, status: 'cancelled' },
        });
      }
      await this.outbox.enqueue(tx, lesson.organizationId, 'notify.rooms', { roomIds: [lesson.roomId] });
      await this.outbox.enqueue(tx, lesson.organizationId, 'notify.devices', { deviceIds: [deviceId] });
    }
  }

  present(row: DeviceRow, report: CapabilityReport | null, agent: Device['agent']): Device {
    const last = row.lastHeartbeatAt?.getTime() ?? null;
    return {
      id: row.id,
      siteId: row.siteId,
      roomId: row.roomId,
      hostname: row.hostname,
      enrolledAt: row.enrolledAt.toISOString(),
      companion: {
        presence: companionPresence(last, this.now()),
        lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
      },
      agent,
      capabilities: report,
    };
  }

  ok(tx: Db, ctx: RequestContext, action: string, row: DeviceRow, details?: Record<string, unknown>) {
    const actor = this.access.actor(ctx);
    return this.audit.write(
      tx,
      {
        organizationId: row.organizationId,
        siteId: row.siteId,
        actorUserId: actor.userId,
        action,
        targetType: 'device',
        targetId: row.id,
        result: 'succeeded',
        details,
      },
      ctx.correlationId,
    );
  }
}
