import { describe, expect, test } from 'vitest';
import { deviceHelpRequestBodySchema, helpRequestSchema } from '../src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = {
  id: id(1),
  lessonId: id(2),
  deviceId: id(3),
  raisedAt: '2026-11-02T10:00:00.000Z',
  clearedAt: null,
  clearReason: null,
};

describe('help request contracts', () => {
  test('help request clear reason is one of four', () => {
    for (const clearReason of ['teacher', 'device', 'lesson_ended', 'device_left'])
      expect(
        helpRequestSchema.safeParse({ ...request, clearedAt: '2026-11-02T10:01:00.000Z', clearReason }).success,
        clearReason,
      ).toBe(true);
    expect(helpRequestSchema.safeParse({ ...request, clearReason: 'timeout' }).success).toBe(false);
    expect(helpRequestSchema.safeParse(request).success).toBe(true);
  });

  test('help request body is empty and strict', () => {
    expect(deviceHelpRequestBodySchema.safeParse({}).success).toBe(true);
    expect(deviceHelpRequestBodySchema.safeParse({ text: 'yordam' }).success).toBe(false);
  });
});
