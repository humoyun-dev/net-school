import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });

export const powerActionTypeSchema = z.enum(['shutdown', 'reboot', 'sleep', 'wake']);
export const powerTargetStatusSchema = z.enum(['pending', 'sent', 'succeeded', 'failed', 'unknown', 'cancelled']);
export const powerFailureReasonSchema = z.enum([
  'unbound',
  'device_offline',
  'wake_unsupported',
  'node_missing',
  'upstream_unavailable',
]);
export const powerActionStatusSchema = z.enum(['scheduled', 'running', 'completed', 'cancelled', 'missed']);

// Ko'lam: butun universitet, binolar (site), xonalar yoki aniq qurilmalar.
export const powerScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('organization') }),
  z.strictObject({ kind: z.literal('sites'), siteIds: z.array(z.uuid()).min(1).max(50) }),
  z.strictObject({ kind: z.literal('rooms'), roomIds: z.array(z.uuid()).min(1).max(200) }),
  z.strictObject({ kind: z.literal('devices'), deviceIds: z.array(z.uuid()).min(1).max(500) }),
]);
export type PowerScope = z.infer<typeof powerScopeSchema>;

// Ko'p qurilmali amal uchun admin ko'rgan son (409 confirmation_required, agar haqiqiy son boshqa bo'lsa).
const confirmDeviceCount = z.int().min(0).optional();

export const createPowerActionRequestSchema = z.strictObject({
  type: powerActionTypeSchema,
  scope: powerScopeSchema,
  runAt: timestamp.optional(),
  confirmDeviceCount,
});
export type CreatePowerActionRequest = z.infer<typeof createPowerActionRequestSchema>;

export const previewPowerRequestSchema = z.strictObject({ type: powerActionTypeSchema, scope: powerScopeSchema });
export type PreviewPowerRequest = z.infer<typeof previewPowerRequestSchema>;

export const powerPreviewSchema = z.object({
  deviceCount: z.int().min(0),
  unbound: z.int().min(0),
  // null — MeshCentral javob bermadi.
  agentOnline: z.int().min(0).nullable(),
  agentOffline: z.int().min(0).nullable(),
});
export type PowerPreview = z.infer<typeof powerPreviewSchema>;

export const powerTargetSchema = z.object({
  deviceId: z.uuid(),
  hostname: z.string(),
  siteId: z.uuid(),
  roomId: z.uuid().nullable(),
  status: powerTargetStatusSchema,
  reason: powerFailureReasonSchema.nullable(),
  sentAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
});
export type PowerTarget = z.infer<typeof powerTargetSchema>;

export const powerActionSchema = z.object({
  id: z.uuid(),
  type: powerActionTypeSchema,
  scope: powerScopeSchema,
  status: powerActionStatusSchema,
  runAt: timestamp,
  scheduleId: z.uuid().nullable(),
  requestedBy: z.uuid().nullable(),
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
  summary: z.record(powerTargetStatusSchema, z.int().min(0)),
  targets: z.array(powerTargetSchema).optional(),
});
export type PowerAction = z.infer<typeof powerActionSchema>;

function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const weeklyRuleSchema = z.strictObject({
  daysOfWeek: z
    .array(z.int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, 'Days must be unique'),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().max(64).refine(isValidTimezone, 'Unknown timezone'),
});
export type WeeklyRuleInput = z.infer<typeof weeklyRuleSchema>;

export const createPowerScheduleRequestSchema = z.strictObject({
  type: powerActionTypeSchema,
  scope: powerScopeSchema,
  rule: weeklyRuleSchema,
  confirmDeviceCount,
});
export type CreatePowerScheduleRequest = z.infer<typeof createPowerScheduleRequestSchema>;

// Ko'lam va tur o'zgarmaydi (yangisini yaratib, tasdiqlash kerak).
export const updatePowerScheduleRequestSchema = z
  .strictObject({ enabled: z.boolean().optional(), rule: weeklyRuleSchema.optional() })
  .refine((v) => v.enabled !== undefined || v.rule !== undefined, 'Nothing to update');
export type UpdatePowerScheduleRequest = z.infer<typeof updatePowerScheduleRequestSchema>;

export const powerScheduleSchema = z.object({
  id: z.uuid(),
  type: powerActionTypeSchema,
  scope: powerScopeSchema,
  rule: weeklyRuleSchema,
  enabled: z.boolean(),
  nextRunAt: timestamp.nullable(),
  createdBy: z.uuid(),
  createdAt: timestamp,
});
export type PowerSchedule = z.infer<typeof powerScheduleSchema>;
