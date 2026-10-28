import type { Role } from '@netschool/domain';
import type { Db } from '../../src/db/client.ts';
import { organizations, roleAssignments, roomMemberships, rooms, sites, users } from '../../src/db/schema.ts';
import { hashPassword } from '../../src/modules/identity/password.ts';

export const PASSWORD = 'Sinov-parol-2026!';

export async function seedOrg(db: Db, name = 'Maktab 1') {
  const [org] = await db.insert(organizations).values({ name }).returning();
  if (!org) throw new Error('seed org');
  const [site] = await db
    .insert(sites)
    .values({ organizationId: org.id, name: `${name} bino A` })
    .returning();
  const [site2] = await db
    .insert(sites)
    .values({ organizationId: org.id, name: `${name} bino B` })
    .returning();
  if (!site || !site2) throw new Error('seed site');
  return { orgId: org.id, siteId: site.id, otherSiteId: site2.id };
}

export async function seedRoom(db: Db, orgId: string, siteId: string, name: string) {
  const [room] = await db.insert(rooms).values({ organizationId: orgId, siteId, name }).returning();
  if (!room) throw new Error('seed room');
  return room.id;
}

export async function seedUser(
  db: Db,
  orgId: string,
  username: string,
  roles: { role: Role; siteId: string | null }[],
  opts: { mustChangePassword?: boolean; roomIds?: string[]; password?: string } = {},
) {
  const [user] = await db
    .insert(users)
    .values({
      organizationId: orgId,
      username,
      displayName: username,
      passwordHash: await hashPassword(opts.password ?? PASSWORD),
      mustChangePassword: opts.mustChangePassword ?? false,
    })
    .returning();
  if (!user) throw new Error('seed user');
  for (const r of roles) await db.insert(roleAssignments).values({ organizationId: orgId, userId: user.id, ...r });
  for (const roomId of opts.roomIds ?? [])
    await db.insert(roomMemberships).values({ organizationId: orgId, roomId, userId: user.id });
  return user.id;
}

export function cookieFrom(setCookie: string | null): string {
  const value = setCookie?.match(/__Host-ns_sid=([^;]*)/)?.[1];
  if (!value) throw new Error('no session cookie');
  return `__Host-ns_sid=${value}`;
}
