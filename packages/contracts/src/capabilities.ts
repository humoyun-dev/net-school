import { z } from 'zod';

// Spec §7: capability javobi boolean emas, holat + sabab.
export const capabilityStateSchema = z.enum([
  'available',
  'requires_permission',
  'requires_setup',
  'unsupported',
  'degraded',
]);

export const capabilityReportSchema = z.object({
  protocolVersion: z.literal(1),
  os: z.enum(['windows', 'macos', 'linux', 'chromeos', 'android', 'ios', 'ipados', 'other']),
  architecture: z.string().min(1),
  desktopSession: z.enum(['x11', 'wayland', 'windows', 'macos', 'none']).nullable(),
  capabilities: z.record(
    z.string().regex(/^[a-z]+(\.[a-z]+)+$/),
    z.strictObject({
      state: capabilityStateSchema,
      provider: z.string().optional(),
      reason: z.string().optional(),
      enforcement: z.enum(['soft', 'hard']).optional(),
    }),
  ),
});

export type CapabilityState = z.infer<typeof capabilityStateSchema>;
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;
