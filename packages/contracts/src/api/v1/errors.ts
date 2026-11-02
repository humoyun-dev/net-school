import { z } from 'zod';

// Barqaror API xato kodlari (spec §9). Server va klient tarjimalari shu ro'yxatdan.
export const API_ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'scope_denied',
  'password_change_required',
  'not_found',
  'conflict',
  'control_busy',
  'capability_unavailable',
  'confirmation_required',
  'rate_limited',
  'upstream_unavailable',
  'device_offline',
  'internal',
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), correlationId: z.string().nullable().optional() }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
