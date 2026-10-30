import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSequence,
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
    // MeshCentral domain ('' = default); null — site MeshCentral'ga bog'lanmagan.
    meshDomainId: text('mesh_domain_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sites_org_id').on(t.organizationId, t.id),
    unique('sites_org_name').on(t.organizationId, t.name),
    uniqueIndex('sites_mesh_domain').on(t.meshDomainId).where(sql`${t.meshDomainId} is not null`),
    // mesh_bindings shu juftlikka bog'lanadi: bog'langan site domain'ini o'zgartirib bo'lmaydi.
    unique('sites_id_mesh_domain').on(t.id, t.meshDomainId),
  ],
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
    unique('rooms_site_id').on(t.siteId, t.id),
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
    check(
      'audit_events_org_required',
      sql`${t.organizationId} is not null or ${t.action} like 'auth.%' or ${t.action} = 'device.claim'`,
    ),
    index('audit_events_org_at').on(t.organizationId, t.at.desc()),
  ],
);

export const enrollments = pgTable(
  'enrollments',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    roomId: uuid('room_id'),
    tokenHash: bytea('token_hash').notNull().unique('enrollments_token_hash'),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    deviceId: uuid('device_id').unique('enrollments_device'),
  },
  (t) => [
    foreignKey({
      name: 'enrollments_site_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    foreignKey({
      name: 'enrollments_room_fk',
      columns: [t.siteId, t.roomId],
      foreignColumns: [rooms.siteId, rooms.id],
    }),
    foreignKey({
      name: 'enrollments_creator_fk',
      columns: [t.organizationId, t.createdBy],
      foreignColumns: [users.organizationId, users.id],
    }),
    index('enrollments_site_created').on(t.siteId, t.createdAt.desc()),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    roomId: uuid('room_id'),
    hostname: text('hostname').notNull(),
    publicKey: bytea('public_key').notNull(),
    keyFingerprint: text('key_fingerprint').notNull().unique('devices_key_fingerprint'),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    // Oxirgi qabul qilingan imzolangan so'rov vaqti (ms); replay himoyasi.
    lastSignedTs: bigint('last_signed_ts', { mode: 'number' }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'devices_site_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    foreignKey({ name: 'devices_room_fk', columns: [t.siteId, t.roomId], foreignColumns: [rooms.siteId, rooms.id] }),
    unique('devices_org_id').on(t.organizationId, t.id),
    unique('devices_site_id').on(t.siteId, t.id),
    index('devices_site_room').on(t.siteId, t.roomId),
  ],
);

export const meshBindings = pgTable(
  'mesh_bindings',
  {
    deviceId: uuid('device_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    meshInstanceId: text('mesh_instance_id').notNull(),
    meshDomainId: text('mesh_domain_id').notNull(),
    meshNodeId: text('mesh_node_id').notNull(),
    boundBy: uuid('bound_by').notNull(),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Upstream node ID global emas: instance va domain bilan birga unique (spec §8).
    unique('mesh_bindings_node').on(t.meshInstanceId, t.meshDomainId, t.meshNodeId),
    foreignKey({
      name: 'mesh_bindings_device_fk',
      columns: [t.siteId, t.deviceId],
      foreignColumns: [devices.siteId, devices.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mesh_bindings_site_domain_fk',
      columns: [t.siteId, t.meshDomainId],
      foreignColumns: [sites.id, sites.meshDomainId],
    }),
    foreignKey({
      name: 'mesh_bindings_org_fk',
      columns: [t.organizationId, t.deviceId],
      foreignColumns: [devices.organizationId, devices.id],
    }).onDelete('cascade'),
  ],
);

export const deviceCapabilities = pgTable(
  'device_capabilities',
  {
    deviceId: uuid('device_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    report: jsonb('report').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'device_capabilities_device_fk',
      columns: [t.organizationId, t.deviceId],
      foreignColumns: [devices.organizationId, devices.id],
    }).onDelete('cascade'),
  ],
);

export const lessons = pgTable(
  'lessons',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    roomId: uuid('room_id').notNull(),
    teacherUserId: uuid('teacher_user_id').notNull(),
    title: text('title'),
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
    endedBy: uuid('ended_by'),
  },
  (t) => [
    foreignKey({
      name: 'lessons_site_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    foreignKey({ name: 'lessons_room_fk', columns: [t.siteId, t.roomId], foreignColumns: [rooms.siteId, rooms.id] }),
    foreignKey({
      name: 'lessons_teacher_fk',
      columns: [t.organizationId, t.teacherUserId],
      foreignColumns: [users.organizationId, users.id],
    }),
    unique('lessons_org_id').on(t.organizationId, t.id),
    unique('lessons_site_id').on(t.siteId, t.id),
    // Spec §8: bitta xonada bitta faol dars.
    uniqueIndex('lessons_room_active').on(t.roomId).where(sql`${t.status} = 'active'`),
    check('lessons_status', sql`${t.status} in ('active', 'ended')`),
    check('lessons_end_reason', sql`${t.endReason} in ('teacher', 'admin', 'timeout')`),
    check(
      'lessons_ended_consistent',
      sql`(${t.status} = 'ended') = (${t.endedAt} is not null) and (${t.status} = 'ended') = (${t.endReason} is not null)`,
    ),
  ],
);

export const lessonDevices = pgTable(
  'lesson_devices',
  {
    lessonId: uuid('lesson_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    // Overlay istalgan holati; qurilma uni heartbeat lease'i bilan oladi (spec §10).
    overlayLocked: boolean('overlay_locked').notNull().default(false),
    overlaySeq: bigint('overlay_seq', { mode: 'number' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'lesson_devices_pk', columns: [t.lessonId, t.deviceId] }),
    foreignKey({
      name: 'lesson_devices_lesson_fk',
      columns: [t.siteId, t.lessonId],
      foreignColumns: [lessons.siteId, lessons.id],
    }),
    foreignKey({
      name: 'lesson_devices_device_fk',
      columns: [t.siteId, t.deviceId],
      foreignColumns: [devices.siteId, devices.id],
    }),
    // Spec §8: bitta qurilmada bitta faol dars biriktirmasi.
    uniqueIndex('lesson_devices_active').on(t.deviceId).where(sql`${t.releasedAt} is null`),
  ],
);

export const commands = pgTable(
  'commands',
  {
    id: id(),
    // Global monoton tartib: qurilma eskirgan buyruqni (kichik seq) qo'llamaydi.
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity().unique('commands_seq'),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    lessonId: uuid('lesson_id').notNull(),
    issuedBy: uuid('issued_by').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'commands_lesson_fk',
      columns: [t.siteId, t.lessonId],
      foreignColumns: [lessons.siteId, lessons.id],
    }),
    foreignKey({
      name: 'commands_issuer_fk',
      columns: [t.organizationId, t.issuedBy],
      foreignColumns: [users.organizationId, users.id],
    }),
    check('commands_type', sql`${t.type} in ('message.show', 'overlay.lock', 'overlay.unlock')`),
    index('commands_lesson_issued').on(t.lessonId, t.issuedAt.desc()),
    index('commands_expires_at').on(t.expiresAt),
  ],
);

export const commandTargets = pgTable(
  'command_targets',
  {
    commandId: uuid('command_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: 'command_targets_pk', columns: [t.commandId, t.deviceId] }),
    foreignKey({ name: 'command_targets_command_fk', columns: [t.commandId], foreignColumns: [commands.id] }).onDelete(
      'cascade',
    ),
    foreignKey({
      name: 'command_targets_device_fk',
      columns: [t.organizationId, t.deviceId],
      foreignColumns: [devices.organizationId, devices.id],
    }),
    check(
      'command_targets_status',
      sql`${t.status} in ('pending', 'sent', 'acknowledged', 'succeeded', 'failed', 'expired', 'cancelled')`,
    ),
    check(
      'command_targets_reason',
      sql`(${t.status} = 'failed') = (${t.reason} is not null) and (${t.reason} is null or ${t.reason} in ('unsupported', 'permission_required', 'error'))`,
    ),
    index('command_targets_device_status').on(t.deviceId, t.status),
    // Maintenance expiry faqat ochiq target'larni ko'radi (kichik partial indeks).
    index('command_targets_open').on(t.commandId).where(sql`${t.status} in ('pending', 'sent', 'acknowledged')`),
  ],
);

export const commandReceipts = pgTable(
  'command_receipts',
  {
    id: id(),
    commandId: uuid('command_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'command_receipts_target_fk',
      columns: [t.commandId, t.deviceId],
      foreignColumns: [commandTargets.commandId, commandTargets.deviceId],
    }).onDelete('cascade'),
  ],
);

export const events = pgTable(
  'events',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    roomId: uuid('room_id').notNull(),
    lessonId: uuid('lesson_id'),
    type: text('type').notNull(),
    data: jsonb('data').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [index('events_room_seq').on(t.roomId, t.seq), index('events_at').on(t.at)],
);

export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid('organization_id').notNull(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    // Parked (10 urinish) qatorlar due indeksiga kirmaydi.
    index('outbox_due').on(t.nextAttemptAt).where(sql`${t.processedAt} is null and ${t.attempts} < 10`),
    index('outbox_processed_at').on(t.processedAt).where(sql`${t.processedAt} is not null`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pk', columns: [t.actorUserId, t.scope, t.key] }),
    index('idempotency_keys_created_at').on(t.createdAt),
  ],
);

export const remoteSessions = pgTable(
  'remote_sessions',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    siteId: uuid('site_id').notNull(),
    roomId: uuid('room_id').notNull(),
    lessonId: uuid('lesson_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    closedBy: uuid('closed_by'),
  },
  (t) => [
    foreignKey({
      name: 'remote_sessions_lesson_fk',
      columns: [t.siteId, t.lessonId],
      foreignColumns: [lessons.siteId, lessons.id],
    }),
    foreignKey({
      name: 'remote_sessions_device_fk',
      columns: [t.siteId, t.deviceId],
      foreignColumns: [devices.siteId, devices.id],
    }),
    foreignKey({
      name: 'remote_sessions_actor_fk',
      columns: [t.organizationId, t.actorUserId],
      foreignColumns: [users.organizationId, users.id],
    }),
    check('remote_sessions_mode', sql`${t.mode} in ('view', 'control')`),
    check('remote_sessions_status', sql`${t.status} in ('opening', 'active', 'closed')`),
    check(
      'remote_sessions_close_reason',
      sql`${t.closeReason} in ('teacher', 'admin', 'lesson_ended', 'device_left', 'lease_expired', 'upstream_failed', 'restart')`,
    ),
    check(
      'remote_sessions_closed_consistent',
      sql`(${t.status} = 'closed') = (${t.closedAt} is not null and ${t.closeReason} is not null) and (${t.closedAt} is not null) = (${t.closeReason} is not null)`,
    ),
    // Faqat ochiq sessiyalar so'raladi: muddat sweep'i, dars yopilishi va qurilma chiqishi.
    index('remote_sessions_open_expires').on(t.expiresAt).where(sql`${t.status} <> 'closed'`),
    index('remote_sessions_open_lesson').on(t.lessonId).where(sql`${t.status} <> 'closed'`),
    index('remote_sessions_open_device').on(t.deviceId).where(sql`${t.status} <> 'closed'`),
  ],
);

// Bitta qurilmada bitta boshqaruv lease'i (primary key); fencing eski egasini rad etish uchun.
export const controlLeases = pgTable(
  'control_leases',
  {
    deviceId: uuid('device_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    sessionId: uuid('session_id').notNull().unique('control_leases_session'),
    fencing: bigint('fencing', { mode: 'number' }).notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({ name: 'control_leases_session_fk', columns: [t.sessionId], foreignColumns: [remoteSessions.id] }),
  ],
);

// Global monoton fencing token'lar (lease olinganda nextval).
export const controlFencingSeq = pgSequence('control_fencing_seq');
