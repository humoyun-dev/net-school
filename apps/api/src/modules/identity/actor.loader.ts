import type { Actor, Role } from '@netschool/domain';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { roleAssignments, roomMemberships, users } from '../../db/schema.ts';

export type UserRow = typeof users.$inferSelect;

export async function loadActor(db: Db, userId: string): Promise<{ user: UserRow; actor: Actor } | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return null;
  const assignments = await db
    .select({ role: roleAssignments.role, siteId: roleAssignments.siteId })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  const rooms = await db
    .select({ roomId: roomMemberships.roomId })
    .from(roomMemberships)
    .where(eq(roomMemberships.userId, userId));
  return {
    user,
    actor: {
      userId: user.id,
      organizationId: user.organizationId,
      assignments: assignments.map((a) => ({
        role: a.role as Role,
        organizationId: user.organizationId,
        siteId: a.siteId,
      })),
      roomIds: rooms.map((r) => r.roomId),
    },
  };
}

export function userSummary(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    mustChangePassword: user.mustChangePassword,
  };
}
