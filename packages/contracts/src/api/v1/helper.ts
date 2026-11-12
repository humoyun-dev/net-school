import { z } from 'zod';
import { baselineRevisionSchema } from './policy.ts';

// OS helper (SYSTEM xizmati) uchun hub shartnomalari: alohida helper kaliti bilan imzolangan so'rovlar (reja P2d1; imzo qoidasi ADR 0005'dagi bilan bir xil).

// GET /api/v1/device/helper/lock-state: faol dars overlay'ining ko'zgusi. Dars yo'q bo'lsa
// `{ locked: false, sequence: null, leaseSeconds }`. Helper lease'ni o'zining monoton taymeri bilan hisoblaydi.
export const helperLockStateSchema = z.object({
  locked: z.boolean(),
  sequence: z.string().nullable(),
  leaseSeconds: z.int().positive(),
  // P2c: bazaviy siyosat revision'i; o'zgarsa helper `/device/helper/policy`ni oladi.
  baseline: baselineRevisionSchema,
});
export type HelperLockState = z.infer<typeof helperLockStateSchema>;

export const helperComponentSchema = z.enum(['active', 'off', 'failed']);
export type HelperComponent = z.infer<typeof helperComponentSchema>;

// PUT /api/v1/device/helper/status: helper komponentlarining joriy holati. Hub eng oxirgisini va qabul vaqtini saqlaydi.
export const helperStatusSchema = z.object({
  version: z.string().min(1).max(64),
  hook: helperComponentSchema,
  policy: helperComponentSchema,
  processGuard: helperComponentSchema,
  cad: z.enum(['blocked', 'unavailable', 'failed', 'off']),
  companion: z.enum(['running', 'restarting', 'no_session']),
  meshAgent: z.enum(['running', 'restarted', 'stopped']),
});
export type HelperStatus = z.infer<typeof helperStatusSchema>;
