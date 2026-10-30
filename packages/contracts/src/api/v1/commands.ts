import { z } from 'zod';
import { lessonSchema } from './lessons.ts';
import { remoteSessionSchema } from './remote-sessions.ts';

const timestamp = z.iso.datetime({ offset: true });

export const targetStatusSchema = z.enum([
  'pending',
  'sent',
  'acknowledged',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
]);
export const failureReasonSchema = z.enum(['unsupported', 'permission_required', 'error']);
export const commandTypeSchema = z.enum(['message.show', 'overlay.lock', 'overlay.unlock']);

// Barcha turlarga umumiy: kimga va qancha muddat.
const targeting = {
  targetDeviceIds: z
    .array(z.uuid())
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate target')
    .optional(),
  ttlSeconds: z.int().min(10).max(600).optional(),
};

// Tur bo'yicha qat'iy payload; ro'yxatda yo'q tur (masalan shell) qabul qilinmaydi.
export const issueCommandRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('message.show'),
    payload: z.strictObject({ text: z.string().min(1).max(500) }),
    ...targeting,
  }),
  z.strictObject({
    type: z.literal('overlay.lock'),
    payload: z.strictObject({ message: z.string().max(200).optional() }),
    ...targeting,
  }),
  z.strictObject({ type: z.literal('overlay.unlock'), payload: z.strictObject({}), ...targeting }),
]);
export type IssueCommandRequest = z.infer<typeof issueCommandRequestSchema>;

export const commandTargetSchema = z.object({
  deviceId: z.uuid(),
  status: targetStatusSchema,
  reason: failureReasonSchema.nullable(),
  updatedAt: timestamp,
});

export const commandSchema = z.object({
  id: z.uuid(),
  lessonId: z.uuid(),
  type: commandTypeSchema,
  sequence: z.string(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  targets: z.array(commandTargetSchema),
  // Har holat bo'yicha son; umumiy "success" yo'q.
  summary: z.record(targetStatusSchema, z.int()),
});
export type Command = z.infer<typeof commandSchema>;

// Qurilmaga boradigan envelope (spec §9).
export const deviceCommandSchema = z.object({
  commandId: z.uuid(),
  sequence: z.string(),
  targetDeviceId: z.uuid(),
  lessonId: z.uuid(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  type: commandTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type DeviceCommand = z.infer<typeof deviceCommandSchema>;
export const deviceCommandsResponseSchema = z.object({ commands: z.array(deviceCommandSchema) });

export const receiptRequestSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('acknowledged') }),
  z.strictObject({ status: z.literal('succeeded') }),
  z.strictObject({ status: z.literal('failed'), reason: failureReasonSchema }),
]);
export type ReceiptRequest = z.infer<typeof receiptRequestSchema>;

export const eventSchema = z.object({
  seq: z.string(),
  type: z.enum([
    'lesson.started',
    'lesson.ended',
    'command.created',
    'command.target_updated',
    'remote_session.opened',
    'remote_session.closed',
  ]),
  at: timestamp,
  lessonId: z.uuid().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type Event = z.infer<typeof eventSchema>;

export const eventsResponseSchema = z.object({
  cursor: z.string(),
  resync: z.boolean(),
  snapshot: z
    .object({
      lesson: lessonSchema.nullable(),
      commands: z.array(commandSchema),
      remoteSessions: z.array(remoteSessionSchema),
    })
    .optional(),
  events: z.array(eventSchema),
});
export type EventsResponse = z.infer<typeof eventsResponseSchema>;
