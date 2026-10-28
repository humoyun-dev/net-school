import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const sites = pgTable(
  'sites',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('sites_org_id').on(t.organizationId, t.id), unique('sites_org_name').on(t.organizationId, t.name)],
);

export const rooms = pgTable(
  'rooms',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'rooms_site_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    unique('rooms_org_id').on(t.organizationId, t.id),
    unique('rooms_site_name').on(t.siteId, t.name),
  ],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_username_lower').on(sql`lower(${t.username})`),
    unique('users_org_id').on(t.organizationId, t.id),
  ],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    siteId: uuid('site_id'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'role_assignments_user_fk',
      columns: [t.organizationId, t.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'role_assignments_site_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    check('role_assignments_role', sql`${t.role} in ('school_admin', 'teacher', 'it_support', 'student')`),
    check('role_assignments_site_required', sql`${t.role} = 'school_admin' or ${t.siteId} is not null`),
    uniqueIndex('role_assignments_unique').on(
      t.userId,
      t.role,
      sql`coalesce(${t.siteId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

export const roomMemberships = pgTable(
  'room_memberships',
  {
    organizationId: uuid('organization_id').notNull(),
    roomId: uuid('room_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'room_memberships_pk', columns: [t.roomId, t.userId] }),
    foreignKey({
      name: 'room_memberships_room_fk',
      columns: [t.organizationId, t.roomId],
      foreignColumns: [rooms.organizationId, rooms.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'room_memberships_user_fk',
      columns: [t.organizationId, t.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
  ],
);

export const authSessions = pgTable('auth_sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: bytea('token_hash').notNull().unique('auth_sessions_token_hash'),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    siteId: uuid('site_id'),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    result: text('result').notNull(),
    correlationId: text('correlation_id').notNull(),
    details: jsonb('details').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('audit_events_result', sql`${t.result} in ('allowed', 'denied', 'failed', 'succeeded')`),
    check('audit_events_org_required', sql`${t.organizationId} is not null or ${t.action} like 'auth.%'`),
    index('audit_events_org_at').on(t.organizationId, t.at.desc()),
  ],
);
