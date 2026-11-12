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
  | 'site.configure_mesh'
  | 'lesson.start'
  | 'lesson.read'
  | 'lesson.end'
  | 'command.issue'
  | 'command.read'
  | 'help.clear'
  | 'remote.view'
  | 'remote.control'
  | 'remote.manage'
  | 'power.manage'
  | 'policy.read'
  | 'policy.manage'
  | 'lesson.policy';

export interface Target {
  organizationId: string;
  siteId?: string | null;
  roomId?: string;
  role?: RoleAssignment; // role.assign / role.remove uchun berilayotgan yoki olinayotgan rol
  ownerUserId?: string; // dars egasi (lesson.end, command.issue, help.clear, remote.view, remote.control)
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
  'lesson.start',
  'lesson.read',
  'lesson.end',
  'command.issue',
  'command.read',
  'help.clear',
  'remote.view',
  'remote.control',
  'remote.manage',
  'power.manage',
  'policy.read',
  'policy.manage',
  'lesson.policy',
]);
// site.configure_mesh hech qaysi to'plamda yo'q: site → MeshCentral domain bog'lanishi faqat org admin'da.
const IT_SUPPORT_ACTIONS = new Set<Action>([
  'site.read',
  'room.read',
  'user.read',
  'device.read',
  'device.enroll',
  'lesson.read',
  'command.read',
  // Quvvat: site IT admini (ADR 0007).
  'power.manage',
  // Bazaviy siyosat: site IT admini o'z site'ida (P2c dizayni §3).
  'policy.read',
  'policy.manage',
]);
const TEACHER_ROOM_ACTIONS = new Set<Action>([
  'room.read',
  'device.read',
  'lesson.start',
  'lesson.read',
  'command.read',
  'policy.read',
]);
// Faqat o'z darsida: boshqa teacher darsini yopish, unga buyruq berish yoki yordam so'rovini yopish (help.clear = command.issue) yoki masofaviy sessiya ochish mumkin emas.
// remote.manage (boshqaning sessiyasini yopish) teacher'da yo'q; it_support va student'da ham remote.* yo'q.
const TEACHER_OWNER_ACTIONS = new Set<Action>([
  'lesson.end',
  'command.issue',
  'help.clear',
  'remote.view',
  'remote.control',
  'lesson.policy',
]);

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
      const inRoom = target.roomId !== undefined && actor.roomIds.includes(target.roomId);
      if (inRoom && TEACHER_ROOM_ACTIONS.has(action)) return ALLOW;
      if (inRoom && TEACHER_OWNER_ACTIONS.has(action) && target.ownerUserId === actor.userId) return ALLOW;
    }
  }
  return DENY;
}
