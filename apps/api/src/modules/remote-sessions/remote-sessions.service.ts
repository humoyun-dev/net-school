import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CapabilityReport, OpenRemoteSessionRequest, RemoteSession, RemoteTicket } from '@netschool/contracts';
import {
  type Action,
  type AuthorizedDesktopRequest,
  type CloseReason,
  CONTROL_LEASE_MS,
  type RemoteMode,
  type RemoteSessionStatus,
  remoteAction,
  type UpstreamDeviceRef,
} from '@netschool/domain';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { Access, type AuditTarget } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import { Idempotency } from '../../common/idempotency.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { API_CONFIG, type ApiConfig } from '../../config/config.ts';
import { DB, type Db } from '../../db/client.ts';
import {
  controlLeases,
  deviceCapabilities,
  devices,
  lessonDevices,
  lessons,
  meshBindings,
  remoteSessions,
  sites,
} from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { DEVICE_MANAGEMENT, type DeviceManagementFactory, requirePort, upstream } from '../devices/mesh.ts';
import { EventLog, Outbox } from '../events/event-log.ts';
import { closeRemoteSessions } from './closing.ts';
import { RemoteGateway } from './remote-gateway.ts';

type SessionRow = typeof remoteSessions.$inferSelect;
type LessonRow = typeof lessons.$inferSelect;

const lessonTarget = (l: Pick<LessonRow, 'organizationId' | 'siteId' | 'roomId' | 'teacherUserId'>) => ({
  organizationId: l.organizationId,
  siteId: l.siteId,
  roomId: l.roomId,
  ownerUserId: l.teacherUserId,
});

// Qurilmaning control lease'i: bo'sh yoki muddati o'tgan bo'lsa shu sessiyaga o'tadi (har safar yangi fencing),
// aks holda null. Parallel olishda PK (device_id) to'qnashuvi commit'gacha kutadi va qayta tekshiriladi.
export async function takeControlLease(
  tx: Db,
  lease: { deviceId: string; organizationId: string; sessionId: string; at: Date },
): Promise<{ fencing: number; expiresAt: Date } | null> {
  const [row] = await tx
    .insert(controlLeases)
    .values({
      deviceId: lease.deviceId,
      organizationId: lease.organizationId,
      sessionId: lease.sessionId,
      fencing: sql`nextval('control_fencing_seq')`,
      acquiredAt: lease.at,
      expiresAt: new Date(lease.at.getTime() + CONTROL_LEASE_MS),
    })
    .onConflictDoUpdate({
      target: controlLeases.deviceId,
      set: {
        sessionId: sql`excluded.session_id`,
        fencing: sql`excluded.fencing`,
        acquiredAt: sql`excluded.acquired_at`,
        expiresAt: sql`excluded.expires_at`,
      },
      setWhere: lte(controlLeases.expiresAt, lease.at),
    })
    .returning({ fencing: controlLeases.fencing, expiresAt: controlLeases.expiresAt });
  return row ?? null;
}

@Injectable()
export class RemoteSessionsService {
  readonly #log = new Logger('RemoteSessions');
  // Jarayon ichida sessiya bir marta aktivlashadi; takroriy so'rov (shu kalit) o'sha va'dani kutadi.
  readonly #activating = new Map<string, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DEVICE_MANAGEMENT) private readonly factory: DeviceManagementFactory | null,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(Idempotency) private readonly idempotency: Idempotency,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(RemoteGateway) private readonly gateway: RemoteGateway,
  ) {}

  // Darvoza tartibi: ruxsat → a'zolik (403) → MeshCentral sozlanganligi → capability → agent online → lease.
  // MeshCentral chaqiruvlari tranzaksiyadan tashqarida: tranzaksiya faqat qatorlarni yozadi.
  async open(ctx: RequestContext, lessonId: string, input: OpenRemoteSessionRequest, key: string) {
    const actor = this.access.actor(ctx);
    const action = remoteAction(input.mode);
    const [lesson] = isUuid(lessonId)
      ? await this.db
          .select()
          .from(lessons)
          .where(and(eq(lessons.id, lessonId), eq(lessons.organizationId, actor.organizationId)))
      : [];
    if (!lesson) return this.access.deny(ctx, action, { targetType: 'lesson', targetId: lessonId });
    await this.access.require(ctx, action, lessonTarget(lesson), { targetType: 'lesson', targetId: lesson.id });
    // Takroriy so'rov darvozadan oldin: sessiyaning joriy holati (ticket saqlanmaydi, javobda ham yo'q).
    const scope = `POST /lessons/${lesson.id}/remote-sessions`;
    const stored = await this.idempotency.replay<RemoteSession>(ctx, scope, key, input);
    if (stored) return { status: stored.status, body: await this.#settled(stored.body.id) };

    if (lesson.status !== 'active') throw new ApiError('conflict', 'Lesson has ended');
    if (!(await this.#isMember(this.db, lesson.id, input.deviceId))) {
      return this.access.deny(ctx, action, { targetType: 'device', targetId: input.deviceId }, lesson.siteId);
    }
    const device = await this.#reachableDevice(lesson.siteId, input.deviceId);

    // Faqat shu so'rov yaratgan sessiyani aktivlashtiradi (parallel bir xil kalit saqlangan javobni oladi).
    const fresh: { session?: SessionRow } = {};
    const result = await this.idempotency.run(ctx, scope, key, input, 201, async (tx) => {
      const [live] = await tx
        .select({ status: lessons.status })
        .from(lessons)
        .where(eq(lessons.id, lesson.id))
        .for('share');
      if (live?.status !== 'active') throw new ApiError('conflict', 'Lesson has ended');
      // A'zolik qatori commit'gacha qulflangan: qurilma chiqishi shu sessiyani ko'rib yopadi.
      if (!(await this.#isMember(tx, lesson.id, input.deviceId, true))) {
        throw new ApiError('conflict', 'Device has left the lesson');
      }
      const at = new Date(this.now());
      const [session] = await tx
        .insert(remoteSessions)
        .values({
          organizationId: lesson.organizationId,
          siteId: lesson.siteId,
          roomId: lesson.roomId,
          lessonId: lesson.id,
          deviceId: input.deviceId,
          actorUserId: actor.userId,
          mode: input.mode,
          status: 'opening',
          openedAt: at,
          expiresAt: new Date(at.getTime() + CONTROL_LEASE_MS),
        })
        .returning();
      if (!session) throw new Error('remote session insert failed');
      if (input.mode === 'control') {
        const lease = await takeControlLease(tx, {
          deviceId: session.deviceId,
          organizationId: lesson.organizationId,
          sessionId: session.id,
          at,
        });
        // Rollback: sessiya ham, idempotency kaliti ham yozilmaydi; MeshCentral'ga murojaat yo'q.
        if (!lease) throw new ApiError('control_busy');
      }
      fresh.session = session;
      return this.view(tx, session.id);
    });
    if (!fresh.session) return { status: result.status, body: await this.#settled(result.body.id) };
    await this.#activation(fresh.session, device, ctx.correlationId);
    return { status: result.status, body: await this.view(this.db, fresh.session.id) };
  }

  async issueTicket(ctx: RequestContext, sessionId: string): Promise<RemoteTicket> {
    const { session, lesson } = await this.#find(ctx, sessionId, 'remote.view');
    const action = remoteAction(session.mode as RemoteMode);
    const on: AuditTarget = { targetType: 'remote_session', targetId: session.id };
    // Ticket faqat sessiya egasiga: admin ham boshqaning sessiyasiga kira olmaydi.
    if (session.actorUserId !== this.access.actor(ctx).userId) return this.access.deny(ctx, action, on, session.siteId);
    await this.access.require(ctx, action, lessonTarget({ ...session, teacherUserId: lesson.teacherUserId }), on);
    if (session.status !== 'active' || session.expiresAt.getTime() <= this.now() || !this.gateway.isOpen(session.id)) {
      throw new ApiError('conflict', 'Remote session is not open');
    }
    const { url, expiresAt } = this.gateway.issueTicket(session.id);
    return { url, expiresAt: new Date(expiresAt).toISOString() };
  }

  async get(ctx: RequestContext, sessionId: string): Promise<RemoteSession> {
    const { session, lesson } = await this.#find(ctx, sessionId, 'remote.manage');
    const own = session.actorUserId === this.access.actor(ctx).userId;
    const action: Action = own ? remoteAction(session.mode as RemoteMode) : 'remote.manage';
    await this.access.require(ctx, action, lessonTarget({ ...session, teacherUserId: lesson.teacherUserId }), {
      targetType: 'remote_session',
      targetId: session.id,
    });
    return this.view(this.db, session.id);
  }

  async view(db: Db, sessionId: string): Promise<RemoteSession> {
    const [row] = await db
      .select({ session: remoteSessions, lease: controlLeases })
      .from(remoteSessions)
      .leftJoin(controlLeases, eq(controlLeases.sessionId, remoteSessions.id))
      .where(eq(remoteSessions.id, sessionId));
    if (!row) throw new Error('remote session missing');
    const { session: s, lease } = row;
    return {
      id: s.id,
      lessonId: s.lessonId,
      deviceId: s.deviceId,
      actorUserId: s.actorUserId,
      mode: s.mode as RemoteMode,
      status: s.status as RemoteSessionStatus,
      openedAt: s.openedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      closeReason: (s.closeReason as CloseReason | null) ?? null,
      lease: lease ? { fencing: String(lease.fencing), expiresAt: lease.expiresAt.toISOString() } : null,
    };
  }

  // Topilmagan yoki begona sessiya — bir xil audit qilingan 403.
  async #find(ctx: RequestContext, sessionId: string, action: Action) {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(sessionId)
      ? await this.db
          .select({ session: remoteSessions, lesson: { teacherUserId: lessons.teacherUserId } })
          .from(remoteSessions)
          .innerJoin(lessons, eq(lessons.id, remoteSessions.lessonId))
          .where(and(eq(remoteSessions.id, sessionId), eq(remoteSessions.organizationId, actor.organizationId)))
      : [];
    return row ?? this.access.deny(ctx, action, { targetType: 'remote_session', targetId: sessionId });
  }

  // Darsning faol a'zosi va retire qilinmagan qurilma.
  async #isMember(db: Db, lessonId: string, deviceId: string, lock = false): Promise<boolean> {
    const query = db
      .select({ deviceId: lessonDevices.deviceId })
      .from(lessonDevices)
      .innerJoin(devices, eq(devices.id, lessonDevices.deviceId))
      .where(
        and(
          eq(lessonDevices.lessonId, lessonId),
          eq(lessonDevices.deviceId, deviceId),
          isNull(lessonDevices.releasedAt),
          isNull(devices.retiredAt),
        ),
      );
    const rows = lock ? await query.for('share', { of: lessonDevices }) : await query;
    return rows.length > 0;
  }

  // MeshCentral sozlangan, qurilma bog'langan, Companion rad etmagan va agent online — aks holda xato.
  async #reachableDevice(siteId: string, deviceId: string): Promise<UpstreamDeviceRef> {
    if (!this.gateway.enabled) throw new ApiError('capability_unavailable', 'Remote desktop is not configured');
    const [site] = await this.db.select().from(sites).where(eq(sites.id, siteId));
    if (!site) throw new Error('lesson site missing');
    const { port, scope } = requirePort(this.factory, this.config.meshInstanceId, site);
    const [binding] = await this.db
      .select()
      .from(meshBindings)
      .where(
        and(
          eq(meshBindings.deviceId, deviceId),
          eq(meshBindings.meshInstanceId, scope.meshInstanceId),
          eq(meshBindings.meshDomainId, scope.meshDomainId),
        ),
      );
    if (!binding) throw new ApiError('capability_unavailable', 'Device is not bound to MeshCentral');
    const [caps] = await this.db
      .select({ report: deviceCapabilities.report })
      .from(deviceCapabilities)
      .where(eq(deviceCapabilities.deviceId, deviceId));
    // Kalit yo'q — manba MeshAgent, ruxsat; Companion holatni bildirgan bo'lsa u available bo'lishi shart.
    const remoteDesktop = (caps?.report as CapabilityReport | undefined)?.capabilities['remote.desktop'];
    if (remoteDesktop && remoteDesktop.state !== 'available') {
      throw new ApiError('capability_unavailable', 'Remote desktop is unavailable on this device');
    }
    const ref = {
      meshInstanceId: binding.meshInstanceId,
      meshDomainId: binding.meshDomainId,
      meshNodeId: binding.meshNodeId,
    };
    const snapshots = await upstream(() => port.listDevices(site.id));
    const online = snapshots.some(
      (s) => s.agentOnline && s.upstream.meshNodeId === ref.meshNodeId && s.upstream.meshDomainId === ref.meshDomainId,
    );
    if (!online) throw new ApiError('device_offline');
    return ref;
  }

  // Boshqa so'rov aktivlashtirayotgan bo'lsa shuni kutadi; natija — sessiyaning joriy holati.
  async #settled(sessionId: string): Promise<RemoteSession> {
    await this.#activating.get(sessionId)?.catch(() => {});
    return this.view(this.db, sessionId);
  }

  #activation(session: SessionRow, device: UpstreamDeviceRef, correlationId: string): Promise<void> {
    const activating = this.#activate(session, device, correlationId).finally(() =>
      this.#activating.delete(session.id),
    );
    this.#activating.set(session.id, activating);
    return activating;
  }

  // Commit'dan keyin: upstream principal → opening→active. Oraliqda yopilgan bo'lsa principal darhol yopiladi.
  async #activate(session: SessionRow, device: UpstreamDeviceRef, correlationId: string): Promise<void> {
    const request: AuthorizedDesktopRequest = {
      sessionId: session.id,
      actorId: session.actorUserId,
      device,
      mode: session.mode as RemoteMode,
    };
    try {
      await upstream(() => this.gateway.open(request));
    } catch (err) {
      // Lease bo'shaydi va sessiya yopiladi; yarim yaratilgan principal'ni broker o'zi qaytaradi.
      await this.db.transaction((tx) =>
        closeRemoteSessions(
          tx,
          { sessionId: session.id },
          'upstream_failed',
          new Date(this.now()),
          null,
          correlationId,
          this.#closeDeps(),
        ),
      );
      throw err;
    }
    let activated: boolean;
    try {
      activated = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(remoteSessions)
          .set({ status: 'active' })
          .where(and(eq(remoteSessions.id, session.id), eq(remoteSessions.status, 'opening')))
          .returning();
        if (!row) return false;
        await this.events.append(tx, {
          organizationId: row.organizationId,
          siteId: row.siteId,
          roomId: row.roomId,
          lessonId: row.lessonId,
          type: 'remote_session.opened',
          data: { sessionId: row.id, deviceId: row.deviceId, mode: row.mode },
        });
        await this.outbox.enqueue(tx, row.organizationId, 'notify.rooms', { roomIds: [row.roomId] });
        await this.audit.write(
          tx,
          {
            organizationId: row.organizationId,
            siteId: row.siteId,
            actorUserId: row.actorUserId,
            action: 'remote_session.open',
            targetType: 'remote_session',
            targetId: row.id,
            result: 'succeeded',
            details: { mode: row.mode, deviceId: row.deviceId },
          },
          correlationId,
        );
        return true;
      });
    } catch (err) {
      // DB'da faol bo'lmagan sessiyaning principal'i tirik qolmaydi (qatorni muddat sweep'i yopadi).
      await this.#revoke(session.id);
      throw err;
    }
    if (!activated) await this.#revoke(session.id);
  }

  // Xato faqat logga: sessiya yopilishi (`remote.revoke` outbox) revoke'ni qayta uriniladi.
  async #revoke(sessionId: string): Promise<void> {
    try {
      await this.gateway.close(sessionId);
    } catch {
      this.#log.warn(`Revoking remote session ${sessionId} failed; it will be retried`);
    }
  }

  #closeDeps() {
    return { events: this.events, outbox: this.outbox, audit: this.audit };
  }
}
