import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });

// Spec §9: business mutation takrorlanmasligi uchun.
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export const startLessonRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(100).optional(),
  durationMinutes: z.int().min(5).max(480).optional(),
});
export type StartLessonRequest = z.infer<typeof startLessonRequestSchema>;

export const lessonSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  roomId: z.uuid(),
  teacherUserId: z.uuid(),
  title: z.string().nullable(),
  status: z.enum(['active', 'ended']),
  startedAt: timestamp,
  scheduledEndAt: timestamp,
  endedAt: timestamp.nullable(),
  endReason: z.enum(['teacher', 'admin', 'timeout']).nullable(),
  deviceIds: z.array(z.uuid()),
});
export type Lesson = z.infer<typeof lessonSchema>;
