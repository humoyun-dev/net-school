import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });

export const helpClearReasonSchema = z.enum(['teacher', 'device', 'lesson_ended', 'device_left']);

export const helpRequestSchema = z.object({
  id: z.uuid(),
  lessonId: z.uuid(),
  deviceId: z.uuid(),
  raisedAt: timestamp,
  clearedAt: timestamp.nullable(),
  clearReason: helpClearReasonSchema.nullable(),
});
export type HelpRequest = z.infer<typeof helpRequestSchema>;

// Matnsiz: qurilma faqat qo'l ko'taradi.
export const deviceHelpRequestBodySchema = z.strictObject({});
