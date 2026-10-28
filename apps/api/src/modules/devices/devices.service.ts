import { Inject, Injectable } from '@nestjs/common';
import type { CapabilityReport, Device } from '@netschool/contracts';
import { companionPresence } from '@netschool/domain';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { deviceCapabilities, devices, meshBindings, rooms, sites } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';

export type DeviceRow = typeof devices.$inferSelect;
export type DeviceListScope = { siteId: string } | { roomId: string };

@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  async list(ctx: RequestContext, scope: DeviceListScope): Promise<Device[]> {
    const actor = this.access.actor(ctx);
    let where: ReturnType<typeof eq>;
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
    }
    const rows = await this.db
      .select({ device: devices, report: deviceCapabilities.report, meshNodeId: meshBindings.meshNodeId })
      .from(devices)
      .leftJoin(deviceCapabilities, eq(deviceCapabilities.deviceId, devices.id))
      .leftJoin(meshBindings, eq(meshBindings.deviceId, devices.id))
      .where(and(where, isNull(devices.retiredAt)))
      .orderBy(asc(devices.hostname), asc(devices.id));
    return rows.map((r) =>
      this.present(r.device, (r.report as CapabilityReport | null) ?? null, r.meshNodeId ? 'unknown' : 'unbound'),
    );
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
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(devices).set({ roomId }).where(eq(devices.id, device.id)).returning();
      if (!row) throw new Error('device update failed');
      await this.ok(tx, ctx, 'device.assign_room', row, { roomId, previousRoomId: device.roomId });
      const [caps] = await tx.select().from(deviceCapabilities).where(eq(deviceCapabilities.deviceId, row.id));
      const [binding] = await tx.select().from(meshBindings).where(eq(meshBindings.deviceId, row.id));
      return this.present(row, (caps?.report as CapabilityReport | undefined) ?? null, binding ? 'unknown' : 'unbound');
    });
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
      await this.ok(tx, ctx, 'device.retire', device);
    });
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
