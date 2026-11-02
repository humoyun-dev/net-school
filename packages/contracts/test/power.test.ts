import { describe, expect, test } from 'vitest';
import {
  createPowerActionRequestSchema,
  createPowerScheduleRequestSchema,
  powerScopeSchema,
  updatePowerScheduleRequestSchema,
  weeklyRuleSchema,
} from '../src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rule = { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '19:00', timezone: 'Asia/Tashkent' };

describe('power contracts', () => {
  test('scope kinds parse and reject empty id lists', () => {
    expect(powerScopeSchema.safeParse({ kind: 'organization' }).success).toBe(true);
    expect(powerScopeSchema.safeParse({ kind: 'sites', siteIds: [id(1)] }).success).toBe(true);
    expect(powerScopeSchema.safeParse({ kind: 'rooms', roomIds: [id(1), id(2)] }).success).toBe(true);
    expect(powerScopeSchema.safeParse({ kind: 'devices', deviceIds: [id(3)] }).success).toBe(true);
    expect(powerScopeSchema.safeParse({ kind: 'sites', siteIds: [] }).success).toBe(false);
    expect(powerScopeSchema.safeParse({ kind: 'devices', deviceIds: ['not-a-uuid'] }).success).toBe(false);
    expect(powerScopeSchema.safeParse({ kind: 'building' }).success).toBe(false);
  });

  test('action request accepts the four types only', () => {
    for (const type of ['shutdown', 'reboot', 'sleep', 'wake'])
      expect(createPowerActionRequestSchema.safeParse({ type, scope: { kind: 'organization' } }).success, type).toBe(
        true,
      );
    expect(createPowerActionRequestSchema.safeParse({ type: 'format', scope: { kind: 'organization' } }).success).toBe(
      false,
    );
    expect(
      createPowerActionRequestSchema.safeParse({
        type: 'reboot',
        scope: { kind: 'organization' },
        runAt: '2026-11-02T19:00:00+05:00',
        confirmDeviceCount: 40,
      }).success,
    ).toBe(true);
  });

  test('weekly rule rejects 24:00, duplicate days, day 0', () => {
    expect(weeklyRuleSchema.safeParse(rule).success).toBe(true);
    expect(weeklyRuleSchema.safeParse({ ...rule, timeOfDay: '24:00' }).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ ...rule, timeOfDay: '7:00' }).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ ...rule, daysOfWeek: [1, 1] }).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ ...rule, daysOfWeek: [0] }).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ ...rule, daysOfWeek: [] }).success).toBe(false);
    expect(weeklyRuleSchema.safeParse({ ...rule, timezone: 'Mars/Base' }).success).toBe(false);
  });

  test('schedule create carries a rule', () => {
    expect(
      createPowerScheduleRequestSchema.safeParse({ type: 'shutdown', scope: { kind: 'organization' }, rule }).success,
    ).toBe(true);
  });

  test('update needs enabled or rule', () => {
    expect(updatePowerScheduleRequestSchema.safeParse({}).success).toBe(false);
    expect(updatePowerScheduleRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updatePowerScheduleRequestSchema.safeParse({ rule }).success).toBe(true);
    expect(updatePowerScheduleRequestSchema.safeParse({ type: 'reboot' }).success).toBe(false);
  });
});
