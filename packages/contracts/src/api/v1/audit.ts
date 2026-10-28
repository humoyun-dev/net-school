import { z } from 'zod';

export const auditQuerySchema = z.object({
  siteId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(200).optional(),
});

export const auditEventSchema = z.object({
  id: z.uuid(),
  at: z.string(),
  siteId: z.uuid().nullable(),
  actorUserId: z.uuid().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  result: z.enum(['allowed', 'denied', 'failed', 'succeeded']),
  correlationId: z.string(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
