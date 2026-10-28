import { Inject, Injectable } from '@nestjs/common';
import { authorize } from '@netschool/domain';
import { and, asc, eq } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { isUniqueViolation, isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { roleAssignments, roomMemberships, rooms, sites, users } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';

type SiteRow = typeof sites.$inferSelect;
type RoomRow = typeof rooms.$inferSelect;

const site = (s: SiteRow) => ({ id: s.id, name: s.name });
const room = (r: RoomRow) => ({ id: r.id, siteId: r.siteId, name: r.name });

@Injectable()
export class OrganizationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  async listSites(ctx: RequestContext) {
    const actor = this.access.actor(ctx);
    const all = await this.db
      .select()
      .from(sites)
      .where(eq(sites.organizationId, actor.organizationId))
      .orderBy(asc(sites.name));
    return all
      .filter((s) => authorize(actor, 'site.read', { organizationId: s.organizationId, siteId: s.id }).allowed)
      .map(site);
  }

  async createSite(ctx: RequestContext, name: string) {
    const actor = await this.access.require(
      ctx,
      'site.create',
      { organizationId: this.access.actor(ctx).organizationId, siteId: null },
      { targetType: 'site', targetId: name },
    );
    return this.#unique(() =>
      this.db.transaction(async (tx) => {
        const [row] = await tx.insert(sites).values({ organizationId: actor.organizationId, name }).returning();
        if (!row) throw new Error('site insert failed');
        await this.#ok(tx, ctx, 'site.create', row.organizationId, row.id, 'site', row.id);
        return site(row);
      }),
    );
  }

  async listRooms(ctx: RequestContext, siteId: string) {
    const actor = this.access.actor(ctx);
    const found = await this.#site(ctx, siteId, 'room.read');
    const all = await this.db.select().from(rooms).where(eq(rooms.siteId, found.id)).orderBy(asc(rooms.name));
    const target = (r: RoomRow) => ({ organizationId: r.organizationId, siteId: r.siteId, roomId: r.id });
    const visible = all.filter((r) => authorize(actor, 'room.read', target(r)).allowed);
    if (
      visible.length === 0 &&
      !authorize(actor, 'site.read', { organizationId: found.organizationId, siteId: found.id }).allowed
    ) {
      return this.access.deny(ctx, 'room.read', { targetType: 'site', targetId: siteId }, found.id);
    }
    return visible.map(room);
  }

  async createRoom(ctx: RequestContext, siteId: string, name: string) {
    const found = await this.#site(ctx, siteId, 'room.create');
    await this.access.require(
      ctx,
      'room.create',
      { organizationId: found.organizationId, siteId: found.id },
      { targetType: 'site', targetId: found.id },
    );
    return this.#unique(() =>
      this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(rooms)
          .values({ organizationId: found.organizationId, siteId: found.id, name })
          .returning();
        if (!row) throw new Error('room insert failed');
        await this.#ok(tx, ctx, 'room.create', row.organizationId, row.siteId, 'room', row.id);
        return room(row);
      }),
    );
  }

  async updateRoom(ctx: RequestContext, roomId: string, name: string) {
    const found = await this.#room(ctx, roomId, 'room.update');
    await this.access.require(
      ctx,
      'room.update',
      { organizationId: found.organizationId, siteId: found.siteId, roomId: found.id },
      { targetType: 'room', targetId: found.id },
    );
    return this.#unique(() =>
      this.db.transaction(async (tx) => {
        const [row] = await tx.update(rooms).set({ name }).where(eq(rooms.id, found.id)).returning();
        if (!row) throw new Error('room update failed');
        await this.#ok(tx, ctx, 'room.update', row.organizationId, row.siteId, 'room', row.id);
        return room(row);
      }),
    );
  }

  async setTeacher(ctx: RequestContext, roomId: string, userId: string, assigned: boolean) {
    const found = await this.#room(ctx, roomId, 'room.assign_teacher');
    await this.access.require(
      ctx,
      'room.assign_teacher',
      { organizationId: found.organizationId, siteId: found.siteId, roomId: found.id },
      { targetType: 'room', targetId: found.id },
    );
    if (!isUuid(userId)) throw new ApiError('conflict', 'User is not a teacher in this site');
    await this.db.transaction(async (tx) => {
      if (assigned) {
        const [teacher] = await tx
          .select({ id: users.id })
          .from(users)
          .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
          .where(
            and(
              eq(users.id, userId),
              eq(users.organizationId, found.organizationId),
              eq(roleAssignments.role, 'teacher'),
              eq(roleAssignments.siteId, found.siteId),
            ),
          );
        if (!teacher) throw new ApiError('conflict', 'User is not a teacher in this site');
        await tx
          .insert(roomMemberships)
          .values({ organizationId: found.organizationId, roomId: found.id, userId })
          .onConflictDoNothing();
      } else {
        await tx
          .delete(roomMemberships)
          .where(and(eq(roomMemberships.roomId, found.id), eq(roomMemberships.userId, userId)));
      }
      await this.#ok(
        tx,
        ctx,
        assigned ? 'room.assign_teacher' : 'room.unassign_teacher',
        found.organizationId,
        found.siteId,
        'room',
        found.id,
        { userId },
      );
    });
  }

  async #site(ctx: RequestContext, siteId: string, action: 'room.read' | 'room.create'): Promise<SiteRow> {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(siteId)
      ? await this.db
          .select()
          .from(sites)
          .where(and(eq(sites.id, siteId), eq(sites.organizationId, actor.organizationId)))
      : [];
    return row ?? this.access.deny(ctx, action, { targetType: 'site', targetId: siteId });
  }

  async #room(ctx: RequestContext, roomId: string, action: 'room.update' | 'room.assign_teacher'): Promise<RoomRow> {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(roomId)
      ? await this.db
          .select()
          .from(rooms)
          .where(and(eq(rooms.id, roomId), eq(rooms.organizationId, actor.organizationId)))
      : [];
    return row ?? this.access.deny(ctx, action, { targetType: 'room', targetId: roomId });
  }

  async #unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('conflict', 'Name already exists');
      throw err;
    }
  }

  #ok(
    tx: Db,
    ctx: RequestContext,
    action: string,
    organizationId: string,
    siteId: string,
    targetType: string,
    targetId: string,
    details?: Record<string, unknown>,
  ) {
    return this.audit.write(
      tx,
      {
        organizationId,
        siteId,
        actorUserId: ctx.actor?.userId ?? null,
        action,
        targetType,
        targetId,
        result: 'succeeded',
        details,
      },
      ctx.correlationId,
    );
  }
}
