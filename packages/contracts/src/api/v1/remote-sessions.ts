import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });

// Qiymatlar @netschool/domain (RemoteMode, RemoteSessionStatus, CloseReason) bilan bir xil bo'lishi shart.
export const remoteModeSchema = z.enum(['view', 'control']);
export const remoteSessionStatusSchema = z.enum(['opening', 'active', 'closed']);
export const closeReasonSchema = z.enum([
  'teacher',
  'admin',
  'lesson_ended',
  'device_left',
  'lease_expired',
  'upstream_failed',
  'restart',
  'superseded',
]);

export const openRemoteSessionRequestSchema = z.strictObject({
  deviceId: z.uuid(),
  mode: remoteModeSchema,
});
export type OpenRemoteSessionRequest = z.infer<typeof openRemoteSessionRequestSchema>;

// fencing — o'nlik satr (bigint 64-bit); `control` uchun majburiyligini servis tekshiradi.
export const renewRemoteSessionRequestSchema = z.strictObject({
  fencing: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
});
export type RenewRemoteSessionRequest = z.infer<typeof renewRemoteSessionRequestSchema>;

export const remoteSessionSchema = z.object({
  id: z.uuid(),
  lessonId: z.uuid(),
  deviceId: z.uuid(),
  actorUserId: z.uuid(),
  mode: remoteModeSchema,
  status: remoteSessionStatusSchema,
  openedAt: timestamp,
  expiresAt: timestamp,
  closedAt: timestamp.nullable(),
  closeReason: closeReasonSchema.nullable(),
  lease: z.object({ fencing: z.string(), expiresAt: timestamp }).nullable(),
});
export type RemoteSession = z.infer<typeof remoteSessionSchema>;

// Brauzer ochadigan bir martalik ticket URL'i; faqat https.
export const remoteTicketSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  expiresAt: timestamp,
});
export type RemoteTicket = z.infer<typeof remoteTicketSchema>;
