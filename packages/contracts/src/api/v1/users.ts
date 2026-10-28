import { z } from 'zod';
import { roleSchema } from './auth.ts';

export const usernameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/i);
// school_admin'dan boshqa rol site talab qiladi (DB check constraint bilan bir xil qoida).
export const roleInputSchema = z
  .strictObject({ role: roleSchema, siteId: z.uuid().nullable() })
  .refine((r) => r.role === 'school_admin' || r.siteId !== null, 'site is required for this role');

export const createUserRequestSchema = z.strictObject({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(256),
  roles: z.array(roleInputSchema).min(1).max(10),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z.strictObject({ disabled: z.boolean() });

export const userSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  mustChangePassword: z.boolean(),
  disabled: z.boolean(),
  roles: z.array(z.object({ id: z.uuid(), role: roleSchema, siteId: z.uuid().nullable() })),
});
export type User = z.infer<typeof userSchema>;
