import { Inject, Injectable } from '@nestjs/common';
import type { CapabilityReport, Device, MeshNode } from '@netschool/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isForeignKeyViolation, isUniqueViolation, isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { API_CONFIG, type ApiConfig } from '../../config/config.ts';
import { DB, type Db } from '../../db/client.ts';
import { deviceCapabilities, devices, meshBindings, sites } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { EventLog, Outbox } from '../events/event-log.ts';
import { closeRemoteSessions } from '../remote-sessions/closing.ts';
import { DevicesService } from './devices.service.ts';
import { DEVICE_MANAGEMENT, type DeviceManagementFactory, requirePort, upstream } from './mesh.ts';

type SiteRow = typeof sites.$inferSelect;

// Companion qurilma ↔ MeshAgent node: faqat admin tasdig'i bilan, node adapter orqali tekshiriladi (spec §6).
@Injectable()
export class MeshBindingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DEVICE_MANAGEMENT) private readonly factory: DeviceManagementFactory | null,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async configureDomain(ctx: RequestContext, siteId: string, meshDomainId: string) {
    const site = await this.#site(ctx, siteId, 'site.configure_mesh');
    await this.access.require(
      ctx,
      'site.configure_mesh',
      { organizationId: site.organizationId, siteId: site.id },
      { targetType: 'site', targetId: site.id },
    );
    try {
      return await this.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(sites).where(eq(sites.id, site.id)).for('update');
        if (locked?.meshDomainId !== meshDomainId) {
          const [bound] = await tx
            .select({ id: meshBindings.deviceId })
            .from(meshBindings)
            .where(eq(meshBindings.siteId, site.id))
            .limit(1);
          if (bound) throw new ApiError('conflict', 'Site has bound devices');
        }
        await tx.update(sites).set({ meshDomainId }).where(eq(sites.id, site.id));
        await this.audit.write(
          tx,
          {
            organizationId: site.organizationId,
            siteId: site.id,
            actorUserId: this.access.actor(ctx).userId,
            action: 'site.configure_mesh',
            targetType: 'site',
            targetId: site.id,
            result: 'succeeded',
            details: { meshDomainId, previous: locked?.meshDomainId ?? null },
          },
          ctx.correlationId,
        );
        return { id: site.id, meshDomainId };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('conflict', 'Mesh domain is used by another site');
      // Parallel bog'lash commit bo'lgan: FK (site_id, mesh_domain_id) domain almashtirishni to'xtatdi.
      if (isForeignKeyViolation(err)) throw new ApiError('conflict', 'Site has bound devices');
      throw err;
    }
  }

  async nodes(ctx: RequestContext, siteId: string): Promise<MeshNode[]> {
    const site = await this.#site(ctx, siteId, 'device.manage');
    await this.access.require(
      ctx,
      'device.manage',
      { organizationId: site.organizationId, siteId: site.id },
      { targetType: 'site', targetId: site.id },
    );
    const { port, scope } = requirePort(this.factory, this.config.meshInstanceId, site);
    const snapshots = await upstream(() => port.listDevices(site.id));
    const bound = await this.db
      .select({ deviceId: meshBindings.deviceId, meshNodeId: meshBindings.meshNodeId })
      .from(meshBindings)
      .where(
        and(eq(meshBindings.meshInstanceId, scope.meshInstanceId), eq(meshBindings.meshDomainId, scope.meshDomainId)),
      );
    const byNode = new Map(bound.map((b) => [b.meshNodeId, b.deviceId]));
    return snapshots.map((s) => ({
      meshNodeId: s.upstream.meshNodeId,
      name: s.name,
      hostname: s.hostname,
      osDescription: s.osDescription,
      agentOnline: s.agentOnline,
      boundDeviceId: byNode.get(s.upstream.meshNodeId) ?? null,
    }));
  }

  async bind(ctx: RequestContext, deviceId: string, meshNodeId: string): Promise<Device> {
    const device = await this.devices.manageable(ctx, deviceId);
    const [site] = await this.db.select().from(sites).where(eq(sites.id, device.siteId));
    if (!site) throw new Error('device site missing');
    const { port, scope } = requirePort(this.factory, this.config.meshInstanceId, site);
    const [existing] = await this.db.select().from(meshBindings).where(eq(meshBindings.deviceId, device.id));
    if (existing && existing.meshNodeId !== meshNodeId)
      throw new ApiError('conflict', 'Device is bound to another node');

    const result = await upstream(() =>
      port.reconcileEnrollment({ siteId: site.id, deviceId: device.id, upstream: { ...scope, meshNodeId } }),
    );
    if (result.status === 'node_not_found') throw new ApiError('conflict', 'Mesh node not found in this site');
    const agent = result.snapshot.agentOnline ? 'online' : 'offline';
    const [caps] = await this.db.select().from(deviceCapabilities).where(eq(deviceCapabilities.deviceId, device.id));
    const view = this.devices.present(device, (caps?.report as CapabilityReport | undefined) ?? null, agent);
    if (existing) return view;

    try {
      await this.db.transaction(async (tx) => {
        // MeshCentral so'rovi davomida qurilma retire qilingan bo'lishi mumkin: qayta tekshirib, retire'ni
        // commit'gacha ushlab turamiz. Site domain'i esa FK (site_id, mesh_domain_id) bilan himoyalangan.
        const [live] = await tx
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, device.id), isNull(devices.retiredAt)))
          .for('share');
        if (!live) throw new ApiError('conflict', 'Device was retired');
        await tx.insert(meshBindings).values({
          deviceId: device.id,
          organizationId: device.organizationId,
          siteId: device.siteId,
          meshInstanceId: scope.meshInstanceId,
          meshDomainId: scope.meshDomainId,
          meshNodeId,
          boundBy: this.access.actor(ctx).userId,
        });
        await this.devices.ok(tx, ctx, 'device.bind', device, { meshNodeId });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('conflict', 'Mesh node or device is already bound');
      if (isForeignKeyViolation(err)) throw new ApiError('conflict', 'Site mesh domain changed');
      throw err;
    }
    return view;
  }

  // Bog'lanish bilan qurilmaning masofaviy sessiyalari ham yopiladi: principal eski node'ga huquqini saqlamaydi va node
  // boshqa qurilmaga bog'lansa begona xona qurilmasiga kirib qolmaydi. Chaqiruvchi commit'dan keyin kick (remote.revoke).
  async unbind(ctx: RequestContext, deviceId: string): Promise<void> {
    const device = await this.devices.manageable(ctx, deviceId);
    await this.db.transaction(async (tx) => {
      const [removed] = await tx.delete(meshBindings).where(eq(meshBindings.deviceId, device.id)).returning();
      if (!removed) throw new ApiError('conflict', 'Device is not bound');
      const actorUserId = this.access.actor(ctx).userId;
      await closeRemoteSessions(
        tx,
        { deviceId: device.id },
        'device_left',
        new Date(this.now()),
        actorUserId,
        ctx.correlationId,
        { events: this.events, outbox: this.outbox, audit: this.audit },
      );
      await this.devices.ok(tx, ctx, 'device.unbind', device, { meshNodeId: removed.meshNodeId });
    });
    this.outbox.kick();
  }

  async #site(ctx: RequestContext, siteId: string, action: 'site.configure_mesh' | 'device.manage'): Promise<SiteRow> {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(siteId)
      ? await this.db
          .select()
          .from(sites)
          .where(and(eq(sites.id, siteId), eq(sites.organizationId, actor.organizationId)))
      : [];
    return row ?? this.access.deny(ctx, action, { targetType: 'site', targetId: siteId });
  }
}
