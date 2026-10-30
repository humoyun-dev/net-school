import { describe, expect, test } from 'vitest';
import { type Action, type Actor, authorize, type Role, type RoleAssignment, type Target } from '../src/index.ts';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const SITE = 'site-1';
const OTHER_SITE = 'site-2';

function actor(assignments: RoleAssignment[], roomIds: string[] = []): Actor {
  return { userId: 'u', organizationId: ORG, assignments, roomIds };
}
const a = (role: Role, siteId: string | null): RoleAssignment => ({ role, organizationId: ORG, siteId });

const actors = {
  orgAdmin: actor([a('school_admin', null)]),
  siteAdmin: actor([a('school_admin', SITE)]),
  itSupport: actor([a('it_support', SITE)]),
  teacher: actor([a('teacher', SITE)], ['room-assigned']),
  student: actor([a('student', SITE)]),
  nobody: actor([]),
};
type Who = keyof typeof actors;

const site = (siteId: string, extra: Partial<Target> = {}): Target => ({ organizationId: ORG, siteId, ...extra });
const room = { roomId: 'room-assigned' };

// [action, target, kimlarga ruxsat] — o'z site'ida.
const ownSite: [Action, Target, Who[]][] = [
  ['organization.read', { organizationId: ORG }, ['orgAdmin', 'siteAdmin', 'itSupport', 'teacher', 'student']],
  ['site.create', { organizationId: ORG, siteId: null }, ['orgAdmin']],
  ['site.read', site(SITE), ['orgAdmin', 'siteAdmin', 'itSupport', 'teacher']],
  ['room.create', site(SITE), ['orgAdmin', 'siteAdmin']],
  ['room.update', site(SITE, room), ['orgAdmin', 'siteAdmin']],
  ['room.read', site(SITE, room), ['orgAdmin', 'siteAdmin', 'itSupport', 'teacher']],
  ['room.read', site(SITE, { roomId: 'room-other' }), ['orgAdmin', 'siteAdmin', 'itSupport']],
  ['room.assign_teacher', site(SITE, room), ['orgAdmin', 'siteAdmin']],
  ['user.create', site(SITE), ['orgAdmin', 'siteAdmin']],
  ['user.read', site(SITE), ['orgAdmin', 'siteAdmin', 'itSupport']],
  ['user.read', { organizationId: ORG, siteId: null }, ['orgAdmin']],
  ['role.assign', site(SITE, { role: a('teacher', SITE) }), ['orgAdmin', 'siteAdmin']],
  ['role.remove', site(SITE, { role: a('it_support', SITE) }), ['orgAdmin', 'siteAdmin']],
  ['role.assign', site(SITE, { role: a('school_admin', SITE) }), ['orgAdmin']],
  ['role.assign', { organizationId: ORG, siteId: null, role: a('school_admin', null) }, ['orgAdmin']],
  ['audit.read', site(SITE), ['orgAdmin', 'siteAdmin']],
  ['audit.read', { organizationId: ORG, siteId: null }, ['orgAdmin']],
  ['device.read', site(SITE), ['orgAdmin', 'siteAdmin', 'itSupport']],
  ['device.read', site(SITE, room), ['orgAdmin', 'siteAdmin', 'itSupport', 'teacher']],
  ['device.read', site(SITE, { roomId: 'room-other' }), ['orgAdmin', 'siteAdmin', 'itSupport']],
  ['device.enroll', site(SITE), ['orgAdmin', 'siteAdmin', 'itSupport']],
  ['device.manage', site(SITE, room), ['orgAdmin', 'siteAdmin']],
  ['site.configure_mesh', site(SITE), ['orgAdmin']],
  ['lesson.start', site(SITE, room), ['orgAdmin', 'siteAdmin', 'teacher']],
  ['lesson.start', site(SITE, { roomId: 'room-other' }), ['orgAdmin', 'siteAdmin']],
  ['lesson.read', site(SITE, room), ['orgAdmin', 'siteAdmin', 'itSupport', 'teacher']],
  ['command.read', site(SITE, room), ['orgAdmin', 'siteAdmin', 'itSupport', 'teacher']],
  ['lesson.end', site(SITE, { ...room, ownerUserId: 'u' }), ['orgAdmin', 'siteAdmin', 'teacher']],
  ['lesson.end', site(SITE, { ...room, ownerUserId: 'someone-else' }), ['orgAdmin', 'siteAdmin']],
  ['command.issue', site(SITE, { ...room, ownerUserId: 'u' }), ['orgAdmin', 'siteAdmin', 'teacher']],
  ['command.issue', site(SITE, { ...room, ownerUserId: 'someone-else' }), ['orgAdmin', 'siteAdmin']],
  ['remote.view', site(SITE, { ...room, ownerUserId: 'u' }), ['orgAdmin', 'siteAdmin', 'teacher']],
  ['remote.view', site(SITE, { ...room, ownerUserId: 'someone-else' }), ['orgAdmin', 'siteAdmin']],
  ['remote.control', site(SITE, { ...room, ownerUserId: 'u' }), ['orgAdmin', 'siteAdmin', 'teacher']],
  ['remote.control', site(SITE, { ...room, ownerUserId: 'someone-else' }), ['orgAdmin', 'siteAdmin']],
  ['remote.manage', site(SITE, { ...room, ownerUserId: 'u' }), ['orgAdmin', 'siteAdmin']],
];

const cases = ownSite.flatMap(([action, target, allowed]) =>
  (Object.keys(actors) as Who[]).map((who) => ({ who, action, target, expected: allowed.includes(who) })),
);

describe('authorize', () => {
  test.each(cases)('$who $action on own site → $expected', ({ who, action, target, expected }) => {
    expect(authorize(actors[who], action, target).allowed).toBe(expected);
  });

  test.each(ownSite.filter(([, t]) => t.siteId))('only the org admin acts on another site: %s', (action, target) => {
    const other: Target = {
      ...target,
      siteId: OTHER_SITE,
      ...(target.role ? { role: { ...target.role, siteId: OTHER_SITE } } : {}),
    };
    for (const who of Object.keys(actors) as Who[]) {
      expect(authorize(actors[who], action, other).allowed, who).toBe(who === 'orgAdmin');
    }
  });

  test.each(ownSite)('nobody acts on another organization: %s', (action, target) => {
    const foreign: Target = { ...target, organizationId: OTHER_ORG };
    for (const who of Object.keys(actors) as Who[]) {
      expect(authorize(actors[who], action, foreign)).toEqual({ allowed: false, reason: 'scope_denied' });
    }
  });

  test('site admin cannot grant school_admin even within own site', () => {
    expect(authorize(actors.siteAdmin, 'role.assign', site(SITE, { role: a('school_admin', SITE) })).allowed).toBe(
      false,
    );
  });

  test('site admin cannot grant roles in another site', () => {
    // Target o'z site'i, lekin berilayotgan rol boshqa site uchun — rad.
    expect(authorize(actors.siteAdmin, 'role.assign', site(SITE, { role: a('teacher', OTHER_SITE) })).allowed).toBe(
      false,
    );
  });

  test('role from another organization cannot be assigned even by the org admin', () => {
    const foreignRole: RoleAssignment = { role: 'teacher', organizationId: OTHER_ORG, siteId: SITE };
    expect(authorize(actors.orgAdmin, 'role.assign', site(SITE, { role: foreignRole })).allowed).toBe(false);
  });

  test('teacher reads only assigned rooms', () => {
    expect(authorize(actors.teacher, 'room.read', site(SITE, { roomId: 'room-assigned' })).allowed).toBe(true);
    expect(authorize(actors.teacher, 'room.read', site(SITE, { roomId: 'room-other' })).allowed).toBe(false);
    expect(authorize(actors.teacher, 'room.read', site(SITE)).allowed).toBe(false);
  });

  test('it_support cannot manage devices', () => {
    expect(authorize(actors.itSupport, 'device.manage', site(SITE)).allowed).toBe(false);
    expect(authorize(actors.itSupport, 'device.enroll', site(SITE)).allowed).toBe(true);
  });

  test('teacher reads devices only in assigned rooms', () => {
    expect(authorize(actors.teacher, 'device.read', site(SITE, { roomId: 'room-assigned' })).allowed).toBe(true);
    expect(authorize(actors.teacher, 'device.read', site(SITE, { roomId: 'room-other' })).allowed).toBe(false);
    expect(authorize(actors.teacher, 'device.read', site(SITE)).allowed).toBe(false);
    expect(authorize(actors.teacher, 'device.enroll', site(SITE, { roomId: 'room-assigned' })).allowed).toBe(false);
  });

  test('site admin cannot configure mesh domain', () => {
    expect(authorize(actors.siteAdmin, 'site.configure_mesh', site(SITE)).allowed).toBe(false);
    expect(authorize(actors.orgAdmin, 'site.configure_mesh', site(SITE)).allowed).toBe(true);
  });

  test('teacher ends and commands only own lesson', () => {
    const own = site(SITE, { roomId: 'room-assigned', ownerUserId: 'u' });
    expect(authorize(actors.teacher, 'lesson.end', own).allowed).toBe(true);
    expect(authorize(actors.teacher, 'command.issue', own).allowed).toBe(true);
    // Egasi bo'lsa ham boshqa xonada emas; ownerUserId berilmasa — rad.
    expect(authorize(actors.teacher, 'command.issue', { ...own, roomId: 'room-other' }).allowed).toBe(false);
    expect(authorize(actors.teacher, 'lesson.end', site(SITE, { roomId: 'room-assigned' })).allowed).toBe(false);
  });

  test('it_support reads lessons but cannot command', () => {
    const own = site(SITE, { roomId: 'room-assigned', ownerUserId: 'u' });
    expect(authorize(actors.itSupport, 'lesson.read', own).allowed).toBe(true);
    expect(authorize(actors.itSupport, 'command.read', own).allowed).toBe(true);
    expect(authorize(actors.itSupport, 'command.issue', own).allowed).toBe(false);
    expect(authorize(actors.itSupport, 'lesson.start', own).allowed).toBe(false);
  });

  test('teacher opens remote sessions only in own lesson', () => {
    const own = site(SITE, { roomId: 'room-assigned', ownerUserId: 'u' });
    for (const action of ['remote.view', 'remote.control'] as const) {
      expect(authorize(actors.teacher, action, own).allowed, action).toBe(true);
      // Boshqa xona, boshqa egasi yoki egasi berilmagan — rad.
      expect(authorize(actors.teacher, action, { ...own, roomId: 'room-other' }).allowed, action).toBe(false);
      expect(authorize(actors.teacher, action, { ...own, ownerUserId: 'someone-else' }).allowed, action).toBe(false);
      expect(authorize(actors.teacher, action, site(SITE, { roomId: 'room-assigned' })).allowed, action).toBe(false);
    }
  });

  test('it_support cannot open lesson remote sessions', () => {
    const own = site(SITE, { roomId: 'room-assigned', ownerUserId: 'u' });
    for (const action of ['remote.view', 'remote.control', 'remote.manage'] as const) {
      expect(authorize(actors.itSupport, action, own).allowed, action).toBe(false);
      expect(authorize(actors.student, action, own).allowed, action).toBe(false);
    }
  });

  test('only admins manage other sessions', () => {
    const foreign = site(SITE, { roomId: 'room-assigned', ownerUserId: 'someone-else' });
    expect(authorize(actors.orgAdmin, 'remote.manage', foreign).allowed).toBe(true);
    expect(authorize(actors.siteAdmin, 'remote.manage', foreign).allowed).toBe(true);
    // Teacher o'z darsida ham boshqa sessiyani yopa olmaydi.
    expect(authorize(actors.teacher, 'remote.manage', { ...foreign, ownerUserId: 'u' }).allowed).toBe(false);
    expect(authorize(actors.teacher, 'remote.manage', foreign).allowed).toBe(false);
  });

  test('actor without assignments is denied everything', () => {
    for (const [action, target] of ownSite) {
      expect(authorize(actors.nobody, action, target).allowed).toBe(false);
    }
  });

  test('an assignment from another organization grants nothing', () => {
    const stray = actor([{ role: 'school_admin', organizationId: OTHER_ORG, siteId: null }]);
    expect(authorize(stray, 'site.create', { organizationId: ORG, siteId: null }).allowed).toBe(false);
  });
});
