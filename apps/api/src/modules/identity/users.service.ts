import { Inject, Injectable } from '@nestjs/common';
import type { CreateUserRequest } from '@netschool/contracts';
import { authorize, type Role, type RoleAssignment } from '@netschool/domain';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUniqueViolation, isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { roleAssignments, sites, users } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { hashPassword } from './password.ts';
import { SessionService } from './sessions.ts';

type UserRow = typeof users.$inferSelect;
type RoleRow = typeof roleAssignments.$inferSelect;

function present(user: UserRow, roles: RoleRow[]) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    mustChangePassword: user.mustChangePassword,
    disabled: user.disabledAt !== null,
    roles: roles.map((r) => ({ id: r.id, role: r.role as Role, siteId: r.siteId })),
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async list(ctx: RequestContext, siteId: string | undefined) {
    const actor = this.access.actor(ctx);
    if (siteId !== undefined && !isUuid(siteId))
      return this.access.deny(ctx, 'user.read', { targetType: 'site', targetId: siteId });
    await this.access.require(
      ctx,
      'user.read',
      { organizationId: actor.organizationId, siteId: siteId ?? null },
      { targetType: 'site', targetId: siteId ?? '*' },
    );
    const roles = await this.db
      .select()
      .from(roleAssignments)
      .where(
        siteId
          ? and(eq(roleAssignments.organizationId, actor.organizationId), eq(roleAssignments.siteId, siteId))
          : eq(roleAssignments.organizationId, actor.organizationId),
      );
    const ids = siteId ? [...new Set(roles.map((r) => r.userId))] : undefined;
    const rows = await this.db
      .select()
      .from(users)
      .where(
        ids
          ? and(
              eq(users.organizationId, actor.organizationId),
              inArray(users.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
            )
          : eq(users.organizationId, actor.organizationId),
      )
      .orderBy(asc(users.username));
    return rows.map((u) =>
      present(
        u,
        roles.filter((r) => r.userId === u.id),
      ),
    );
  }

  async create(ctx: RequestContext, input: CreateUserRequest) {
    const actor = this.access.actor(ctx);
    await this.#requireRoles(ctx, input.roles, input.username);
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            organizationId: actor.organizationId,
            username: input.username.toLowerCase(),
            displayName: input.displayName,
            passwordHash,
            mustChangePassword: true,
          })
          .returning();
        if (!user) throw new Error('user insert failed');
        const roles = await tx
          .insert(roleAssignments)
          .values(
            input.roles.map((r) => ({
              organizationId: actor.organizationId,
              userId: user.id,
              role: r.role,
              siteId: r.siteId,
            })),
          )
          .returning();
        await this.#ok(tx, ctx, 'user.create', user.id, { roles: input.roles });
        return present(user, roles);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('conflict', 'Username or role already exists');
      throw err;
    }
  }

  async addRole(ctx: RequestContext, userId: string, role: { role: Role; siteId: string | null }) {
    const user = await this.#user(ctx, userId, 'role.assign');
    await this.#requireRoles(ctx, [role], user.id);
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(roleAssignments)
          .values({ organizationId: user.organizationId, userId: user.id, ...role })
          .returning();
        if (!row) throw new Error('role insert failed');
        await this.#ok(tx, ctx, 'role.assign', user.id, { role: role.role, siteId: role.siteId });
        return { id: row.id, role: row.role as Role, siteId: row.siteId };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('conflict', 'Role already assigned');
      throw err;
    }
  }

  async removeRole(ctx: RequestContext, userId: string, assignmentId: string) {
    const user = await this.#user(ctx, userId, 'role.remove');
    const [row] = isUuid(assignmentId)
      ? await this.db
          .select()
          .from(roleAssignments)
          .where(and(eq(roleAssignments.id, assignmentId), eq(roleAssignments.userId, user.id)))
      : [];
    if (!row) return this.access.deny(ctx, 'role.remove', { targetType: 'role_assignment', targetId: assignmentId });
    const assignment: RoleAssignment = {
      role: row.role as Role,
      organizationId: row.organizationId,
      siteId: row.siteId,
    };
    await this.access.require(
      ctx,
      'role.remove',
      { organizationId: row.organizationId, siteId: row.siteId, role: assignment },
      { targetType: 'role_assignment', targetId: row.id },
    );
    await this.db.transaction(async (tx) => {
      if (
        row.role === 'school_admin' &&
        row.siteId === null &&
        (await this.#orgAdminCount(tx, row.organizationId)) <= 1
      ) {
        throw new ApiError('conflict', 'Cannot remove the last organization admin');
      }
      await tx.delete(roleAssignments).where(eq(roleAssignments.id, row.id));
      await this.sessions.revokeAllForUser(tx, user.id);
      await this.#ok(tx, ctx, 'role.remove', user.id, { role: row.role, siteId: row.siteId });
    });
  }

  async setDisabled(ctx: RequestContext, userId: string, disabled: boolean) {
    const actor = this.access.actor(ctx);
    const user = await this.#user(ctx, userId, 'role.remove');
    const roles = await this.db.select().from(roleAssignments).where(eq(roleAssignments.userId, user.id));
    // Faqat foydalanuvchining hamma rolini olib tashlay oladigan actor uni o'chira oladi.
    const targets = roles.length
      ? roles.map((r) => ({
          organizationId: r.organizationId,
          siteId: r.siteId,
          role: { role: r.role as Role, organizationId: r.organizationId, siteId: r.siteId },
        }))
      : [{ organizationId: user.organizationId, siteId: null }];
    for (const target of targets) {
      const action = 'role' in target ? 'role.remove' : 'user.read';
      if (!authorize(actor, action, target).allowed)
        return this.access.deny(ctx, 'role.remove', { targetType: 'user', targetId: user.id });
    }
    if (disabled && user.id === actor.userId) throw new ApiError('conflict', 'Cannot disable yourself');
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(users)
        .set({ disabledAt: disabled ? new Date(this.now()) : null })
        .where(eq(users.id, user.id))
        .returning();
      if (!row) throw new Error('user update failed');
      if (disabled) await this.sessions.revokeAllForUser(tx, user.id);
      await this.#ok(tx, ctx, disabled ? 'user.disable' : 'user.enable', user.id);
      return present(row, roles);
    });
  }

  async #requireRoles(ctx: RequestContext, roles: { role: Role; siteId: string | null }[], targetId: string) {
    const actor = this.access.actor(ctx);
    const siteIds = [...new Set(roles.map((r) => r.siteId).filter((s): s is string => s !== null))];
    const known = siteIds.length
      ? await this.db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.organizationId, actor.organizationId), inArray(sites.id, siteIds)))
      : [];
    if (known.length !== siteIds.length) return this.access.deny(ctx, 'role.assign', { targetType: 'user', targetId });
    for (const r of roles) {
      const role: RoleAssignment = { ...r, organizationId: actor.organizationId };
      await this.access.require(
        ctx,
        'role.assign',
        { organizationId: actor.organizationId, siteId: r.siteId, role },
        { targetType: 'user', targetId },
      );
    }
  }

  async #user(ctx: RequestContext, userId: string, action: 'role.assign' | 'role.remove'): Promise<UserRow> {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(userId)
      ? await this.db
          .select()
          .from(users)
          .where(and(eq(users.id, userId), eq(users.organizationId, actor.organizationId)))
      : [];
    return row ?? this.access.deny(ctx, action, { targetType: 'user', targetId: userId });
  }

  async #orgAdminCount(tx: Db, organizationId: string): Promise<number> {
    const rows = await tx
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(
        and(
          eq(roleAssignments.organizationId, organizationId),
          eq(roleAssignments.role, 'school_admin'),
          isNull(roleAssignments.siteId),
          isNull(users.disabledAt),
        ),
      )
      .for('update');
    return rows.length;
  }

  #ok(tx: Db, ctx: RequestContext, action: string, userId: string, details?: Record<string, unknown>) {
    const actor = this.access.actor(ctx);
    return this.audit.write(
      tx,
      {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action,
        targetType: 'user',
        targetId: userId,
        result: 'succeeded',
        details,
      },
      ctx.correlationId,
    );
  }
}
