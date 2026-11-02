import type { PowerScope } from '@netschool/contracts';
import { type Actor, authorize } from '@netschool/domain';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Access } from '../../common/access.ts';
import type { RequestContext } from '../../common/request-context.ts';
import type { Db } from '../../db/client.ts';
import { devices, meshBindings, rooms, sites } from '../../db/schema.ts';

export interface ScopeDevice {
  id: string;
  siteId: string;
  roomId: string | null;
  bound: boolean;
}

// Ko'lamning har site'i uchun power.manage; organization — faqat org-wide admin. Noma'lum yoki begona id —
// xuddi ruxsatsizlik kabi audit qilingan 403. Ko'lam site'larini qaytaradi.
export async function authorizeScope(
  db: Db,
  access: Access,
  ctx: RequestContext,
  scope: PowerScope,
  on: { targetType: string; targetId: string },
): Promise<string[]> {
  const actor = access.actor(ctx);
  const org = actor.organizationId;
  if (scope.kind === 'organization') {
    await access.require(ctx, 'power.manage', { organizationId: org }, on);
    return (await db.select({ id: sites.id }).from(sites).where(eq(sites.organizationId, org))).map((s) => s.id);
  }
  let found: Map<string, string>; // id → siteId
  let wanted: string[];
  let targetType: string;
  if (scope.kind === 'sites') {
    wanted = scope.siteIds;
    targetType = 'site';
    const rows = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.organizationId, org), inArray(sites.id, wanted)));
    found = new Map(rows.map((r) => [r.id, r.id]));
  } else if (scope.kind === 'rooms') {
    wanted = scope.roomIds;
    targetType = 'room';
    const rows = await db
      .select({ id: rooms.id, siteId: rooms.siteId })
      .from(rooms)
      .where(and(eq(rooms.organizationId, org), inArray(rooms.id, wanted)));
    found = new Map(rows.map((r) => [r.id, r.siteId]));
  } else {
    wanted = scope.deviceIds;
    targetType = 'device';
    const rows = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.organizationId, org), inArray(devices.id, wanted), isNull(devices.retiredAt)));
    found = new Map(rows.map((r) => [r.id, r.siteId]));
  }
  const missing = wanted.find((id) => !found.has(id));
  if (missing) return access.deny(ctx, 'power.manage', { targetType, targetId: missing });
  const siteIds = [...new Set(found.values())].sort();
  for (const siteId of siteIds) {
    await access.require(ctx, 'power.manage', { organizationId: org, siteId }, on);
  }
  return siteIds;
}

// Amal yoki jadvalni ko'rish/o'zgartirish: ko'lamning hamma site'iga ruxsat (organization — org admin).
export function canManage(actor: Actor, organizationId: string, scope: PowerScope, siteIds: string[]): boolean {
  if (actor.organizationId !== organizationId) return false;
  if (scope.kind === 'organization') return authorize(actor, 'power.manage', { organizationId }).allowed;
  return siteIds.every((siteId) => authorize(actor, 'power.manage', { organizationId, siteId }).allowed);
}

// Joriy holat bo'yicha qurilmalar (retired chiqariladi); bound — mesh binding bor.
export async function resolveScope(db: Db, organizationId: string, scope: PowerScope): Promise<ScopeDevice[]> {
  const base = and(eq(devices.organizationId, organizationId), isNull(devices.retiredAt));
  const where =
    scope.kind === 'organization'
      ? base
      : scope.kind === 'sites'
        ? and(base, inArray(devices.siteId, scope.siteIds))
        : scope.kind === 'rooms'
          ? and(base, inArray(devices.roomId, scope.roomIds))
          : and(base, inArray(devices.id, scope.deviceIds));
  const rows = await db
    .select({ id: devices.id, siteId: devices.siteId, roomId: devices.roomId, binding: meshBindings.deviceId })
    .from(devices)
    .leftJoin(meshBindings, eq(meshBindings.deviceId, devices.id))
    .where(where)
    .orderBy(devices.id);
  return rows.map((r) => ({ id: r.id, siteId: r.siteId, roomId: r.roomId, bound: r.binding !== null }));
}

// Audit uchun ixcham ko'lam (500 ta id audit hajmidan oshmasin).
export function scopeSummary(scope: PowerScope): Record<string, unknown> {
  if (scope.kind === 'organization') return { kind: 'organization' };
  const ids = scope.kind === 'sites' ? scope.siteIds : scope.kind === 'rooms' ? scope.roomIds : scope.deviceIds;
  return { kind: scope.kind, count: ids.length, ids: ids.slice(0, 20) };
}
