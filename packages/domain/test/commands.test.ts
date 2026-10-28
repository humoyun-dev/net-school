import { describe, expect, test } from 'vitest';
import {
  applyReceipt,
  COMMAND_CAPABILITY,
  gateTarget,
  type ReceiptStatus,
  type TargetStatus,
  TERMINAL,
} from '../src/index.ts';

describe('command gate', () => {
  test('gate maps capability states', () => {
    expect(COMMAND_CAPABILITY).toEqual({
      'message.show': 'classroom.message',
      'overlay.lock': 'classroom.overlay',
      'overlay.unlock': 'classroom.overlay',
    });
    const caps = (state: string) => ({ 'classroom.overlay': { state } });
    expect(gateTarget('overlay.lock', caps('available'))).toEqual({ status: 'pending' });
    expect(gateTarget('overlay.lock', caps('requires_permission'))).toEqual({
      status: 'failed',
      reason: 'permission_required',
    });
    for (const state of ['unsupported', 'requires_setup', 'degraded']) {
      expect(gateTarget('overlay.unlock', caps(state))).toEqual({ status: 'failed', reason: 'unsupported' });
    }
    expect(gateTarget('message.show', caps('available'))).toEqual({ status: 'failed', reason: 'unsupported' });
    expect(gateTarget('message.show', null)).toEqual({ status: 'failed', reason: 'unsupported' });
  });
});

describe('receipt transitions', () => {
  const statuses: TargetStatus[] = ['pending', 'sent', 'acknowledged', 'succeeded', 'failed', 'expired', 'cancelled'];
  // [current, receipt] → kutilgan natija
  const expected: Record<TargetStatus, Record<ReceiptStatus, string>> = {
    pending: { acknowledged: 'apply:acknowledged', succeeded: 'apply:succeeded', failed: 'apply:failed' },
    sent: { acknowledged: 'apply:acknowledged', succeeded: 'apply:succeeded', failed: 'apply:failed' },
    acknowledged: { acknowledged: 'noop', succeeded: 'apply:succeeded', failed: 'apply:failed' },
    succeeded: { acknowledged: 'reject', succeeded: 'noop', failed: 'reject' },
    failed: { acknowledged: 'reject', succeeded: 'reject', failed: 'noop' },
    expired: { acknowledged: 'reject', succeeded: 'reject', failed: 'reject' },
    cancelled: { acknowledged: 'reject', succeeded: 'reject', failed: 'reject' },
  };

  test('receipt transitions follow the lifecycle', () => {
    for (const current of statuses) {
      for (const receipt of ['acknowledged', 'succeeded', 'failed'] as ReceiptStatus[]) {
        const t = applyReceipt(current, receipt);
        const got = t.kind === 'apply' ? `apply:${t.to}` : t.kind;
        expect(got, `${current} + ${receipt}`).toBe(expected[current][receipt]);
      }
    }
  });

  test('terminal states never change', () => {
    expect([...TERMINAL].sort()).toEqual(['cancelled', 'expired', 'failed', 'succeeded']);
    for (const current of TERMINAL) {
      for (const receipt of ['acknowledged', 'succeeded', 'failed'] as ReceiptStatus[]) {
        expect(applyReceipt(current, receipt).kind).not.toBe('apply');
      }
    }
  });
});
