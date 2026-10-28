import { randomUUID } from 'node:crypto';
import type { TestApp } from './app.ts';

export const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });

export function startLesson(app: TestApp, cookie: string, roomId: string, body: unknown = {}, key = idem()) {
  return app.request('POST', `/api/v1/rooms/${roomId}/lessons`, { body, cookie, headers: key });
}

export function endLesson(app: TestApp, cookie: string, lessonId: string, key = idem()) {
  return app.request('POST', `/api/v1/lessons/${lessonId}/end`, { body: {}, cookie, headers: key });
}
