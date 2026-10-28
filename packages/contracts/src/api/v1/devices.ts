import { z } from 'zod';
import { capabilityReportSchema } from '../../capabilities.ts';

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.iso.datetime({ offset: true });

export const createEnrollmentRequestSchema = z.strictObject({
  siteId: z.uuid(),
  roomId: z.uuid().optional(),
  expiresInMinutes: z.int().min(5).max(1440).optional(),
});
export type CreateEnrollmentRequest = z.infer<typeof createEnrollmentRequestSchema>;

export const enrollmentSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  roomId: z.uuid().nullable(),
  status: z.enum(['pending', 'claimed', 'expired', 'revoked']),
  expiresAt: timestamp,
  createdAt: timestamp,
  deviceId: z.uuid().nullable(),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;

// Token faqat shu javobda, bir marta qaytadi.
export const createEnrollmentResponseSchema = enrollmentSchema.extend({ token: z.string() });
export type CreateEnrollmentResponse = z.infer<typeof createEnrollmentResponseSchema>;

export const claimRequestSchema = z.strictObject({
  token: z.string().regex(/^nse_[A-Za-z0-9_-]{43}$/),
  publicKey: base64url.max(128),
  proof: base64url.max(128),
  hostname: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[\x21-\x7e]+$/),
  capabilities: capabilityReportSchema,
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const claimResponseSchema = z.object({
  deviceId: z.uuid(),
  siteId: z.uuid(),
  heartbeatIntervalSeconds: z.literal(10),
});

export const heartbeatRequestSchema = z.strictObject({});
// Overlay faqat lease ichida turadi: server javob bermasa qurilma uni o'zi olib tashlaydi (spec §10).
export const heartbeatLessonSchema = z.object({
  id: z.uuid(),
  overlay: z.object({
    locked: z.boolean(),
    sequence: z.string().nullable(),
    leaseExpiresAt: timestamp,
    leaseSeconds: z.int().positive(),
  }),
});
export const heartbeatResponseSchema = z.object({
  heartbeatIntervalSeconds: z.literal(10),
  lesson: heartbeatLessonSchema.nullable(),
});

export const deviceSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  roomId: z.uuid().nullable(),
  hostname: z.string(),
  enrolledAt: timestamp,
  companion: z.object({
    presence: z.enum(['online', 'stale', 'never']),
    lastHeartbeatAt: timestamp.nullable(),
  }),
  agent: z.enum(['online', 'offline', 'unknown', 'unbound']),
  capabilities: capabilityReportSchema.nullable(),
});
export type Device = z.infer<typeof deviceSchema>;

export const assignRoomRequestSchema = z.strictObject({ roomId: z.uuid().nullable() });
export const meshBindingRequestSchema = z.strictObject({ meshNodeId: z.string().regex(/^[A-Za-z0-9@$_-]{1,128}$/) });
// '' — MeshCentral default domain.
export const meshDomainRequestSchema = z.strictObject({ meshDomainId: z.string().regex(/^[a-z0-9_-]{0,64}$/) });

export const meshNodeSchema = z.object({
  meshNodeId: z.string(),
  name: z.string(),
  hostname: z.string().nullable(),
  osDescription: z.string().nullable(),
  agentOnline: z.boolean(),
  boundDeviceId: z.uuid().nullable(),
});
export type MeshNode = z.infer<typeof meshNodeSchema>;
