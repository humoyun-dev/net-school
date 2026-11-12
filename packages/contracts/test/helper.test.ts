import { describe, expect, test } from 'vitest';
import { helperLockStateSchema, helperStatusSchema } from '../src/index.ts';

const status = {
  version: '0.1.0',
  hook: 'active',
  policy: 'off',
  processGuard: 'failed',
  cad: 'unavailable',
  companion: 'no_session',
  meshAgent: 'restarted',
};

describe('helper contracts', () => {
  test('lock state accepts the idle and locked shapes', () => {
    expect(helperLockStateSchema.safeParse({ locked: false, sequence: null, leaseSeconds: 120 }).success).toBe(true);
    expect(helperLockStateSchema.safeParse({ locked: true, sequence: '42', leaseSeconds: 120 }).success).toBe(true);
    expect(helperLockStateSchema.safeParse({ locked: true, sequence: 42, leaseSeconds: 120 }).success).toBe(false);
    expect(helperLockStateSchema.safeParse({ locked: true, sequence: '42', leaseSeconds: 0 }).success).toBe(false);
  });

  test('status accepts only the documented values', () => {
    expect(helperStatusSchema.safeParse(status).success).toBe(true);
    for (const bad of [
      { ...status, hook: 'running' },
      { ...status, cad: 'active' },
      { ...status, companion: 'stopped' },
      { ...status, meshAgent: 'off' },
      { ...status, version: '' },
      { ...status, policy: undefined },
    ]) {
      expect(helperStatusSchema.safeParse(bad).success).toBe(false);
    }
  });
});
