import { z } from 'zod';

export const loginRequestSchema = z.strictObject({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const passwordChangeRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
});
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

export const userSummarySchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  mustChangePassword: z.boolean(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const roleSchema = z.enum(['school_admin', 'teacher', 'it_support', 'student']);

export const loginResponseSchema = z.object({ user: userSummarySchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const meResponseSchema = z.object({
  user: userSummarySchema,
  organizationId: z.uuid(),
  assignments: z.array(z.object({ role: roleSchema, siteId: z.uuid().nullable() })),
  roomIds: z.array(z.uuid()),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
