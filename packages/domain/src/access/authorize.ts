import type { Actor, RoleAssignment } from './roles.ts';

export type Action =
  | 'organization.read'
  | 'site.create'
  | 'site.read'
  | 'room.create'
  | 'room.update'
  | 'room.read'
  | 'room.assign_teacher'
  | 'user.create'
  | 'user.read'
  | 'role.assign'
  | 'role.remove'
  | 'audit.read'
  | 'device.read'
  | 'device.enroll'
  | 'device.manage'
  | 'site.configure_mesh';

export interface Target {
  organizationId: string;
  siteId?: string | null;
  roomId?: string;
  role?: RoleAssignment; // role.assign / role.remove uchun berilayotgan yoki olinayotgan rol
}

export type Decision = { allowed: true } | { allowed: false; reason: 'scope_denied' };

const ALLOW: Decision = { allowed: true };
const DENY: Decision = { allowed: false, reason: 'scope_denied' };

const SITE_ADMIN_ACTIONS = new Set<Action>([
  'site.read',
  'room.create',
  'room.update',
  'room.read',
  'room.assign_teacher',
  'user.create',
  'user.read',
  'audit.read',
  'device.read',
  'device.enroll',
  'device.manage',
]);
// site.configure_mesh hech qaysi to'plamda yo'q: site → MeshCentral domain bog'lanishi faqat org admin'da.
const IT_SUPPORT_ACTIONS = new Set<Action>(['site.read', 'room.read', 'user.read', 'device.read', 'device.enroll']);
const TEACHER_ROOM_ACTIONS = new Set<Action>(['room.read', 'device.read']);

// Sof qoida: rad etish default; har ruxsat aniq rol va ko'lamdan kelib chiqadi.
export function authorize(actor: Actor, action: Action, target: Target): Decision {
  if (actor.organizationId !== target.organizationId) return DENY;
  const own = actor.assignments.filter((x) => x.organizationId === actor.organizationId);
  if (own.length === 0) return DENY;
  if (action === 'organization.read') return ALLOW;
  if (target.role && target.role.organizationId !== target.organizationId) return DENY;

  if (own.some((x) => x.role === 'school_admin' && x.siteId === null)) return ALLOW;

  const siteId = target.siteId ?? null;
  if (siteId === null) return DENY;
  const here = own.filter((x) => x.siteId === siteId);

  for (const { role } of here) {
    if (role === 'school_admin') {
      if (SITE_ADMIN_ACTIONS.has(action)) return ALLOW;
      if ((action === 'role.assign' || action === 'role.remove') && target.role) {
        if (target.role.siteId === siteId && target.role.role !== 'school_admin') return ALLOW;
      }
    }
    if (role === 'it_support' && IT_SUPPORT_ACTIONS.has(action)) return ALLOW;
    if (role === 'teacher') {
      if (action === 'site.read') return ALLOW;
      if (TEACHER_ROOM_ACTIONS.has(action) && target.roomId !== undefined && actor.roomIds.includes(target.roomId)) {
        return ALLOW;
      }
    }
  }
  return DENY;
}
