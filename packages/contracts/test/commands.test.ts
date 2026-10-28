import { describe, expect, test } from 'vitest';
import {
  heartbeatResponseSchema,
  idempotencyKeySchema,
  issueCommandRequestSchema,
  receiptRequestSchema,
} from '../src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('command contracts', () => {
  test('command payload must match its type', () => {
    expect(issueCommandRequestSchema.safeParse({ type: 'message.show', payload: { text: 'Salom' } }).success).toBe(
      true,
    );
    expect(issueCommandRequestSchema.safeParse({ type: 'message.show', payload: {} }).success).toBe(false);
    expect(issueCommandRequestSchema.safeParse({ type: 'message.show', payload: { text: '' } }).success).toBe(false);
    expect(
      issueCommandRequestSchema.safeParse({ type: 'message.show', payload: { text: 'x'.repeat(501) } }).success,
    ).toBe(false);
    expect(issueCommandRequestSchema.safeParse({ type: 'overlay.lock', payload: {} }).success).toBe(true);
    expect(issueCommandRequestSchema.safeParse({ type: 'overlay.lock', payload: { message: 'Diqqat' } }).success).toBe(
      true,
    );
    expect(issueCommandRequestSchema.safeParse({ type: 'overlay.unlock', payload: { message: 'x' } }).success).toBe(
      false,
    );
    expect(issueCommandRequestSchema.safeParse({ type: 'overlay.lock', payload: {}, ttlSeconds: 5 }).success).toBe(
      false,
    );
  });

  test('unknown command type is rejected', () => {
    expect(issueCommandRequestSchema.safeParse({ type: 'shell.run', payload: { cmd: 'rm -rf /' } }).success).toBe(
      false,
    );
  });

  test('failed receipt requires a reason and others forbid it', () => {
    expect(receiptRequestSchema.safeParse({ status: 'failed', reason: 'unsupported' }).success).toBe(true);
    expect(receiptRequestSchema.safeParse({ status: 'failed' }).success).toBe(false);
    expect(receiptRequestSchema.safeParse({ status: 'succeeded' }).success).toBe(true);
    expect(receiptRequestSchema.safeParse({ status: 'succeeded', reason: 'error' }).success).toBe(false);
    expect(receiptRequestSchema.safeParse({ status: 'sent' }).success).toBe(false);
  });

  test('duplicate target ids are rejected', () => {
    const base = { type: 'overlay.unlock', payload: {} };
    expect(issueCommandRequestSchema.safeParse({ ...base, targetDeviceIds: [id(1), id(2)] }).success).toBe(true);
    expect(issueCommandRequestSchema.safeParse({ ...base, targetDeviceIds: [id(1), id(1)] }).success).toBe(false);
    expect(issueCommandRequestSchema.safeParse({ ...base, targetDeviceIds: [] }).success).toBe(false);
  });

  test('idempotency key and heartbeat lesson shape', () => {
    expect(idempotencyKeySchema.safeParse('abc-123_XYZ').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has space here').success).toBe(false);
    expect(heartbeatResponseSchema.safeParse({ heartbeatIntervalSeconds: 10, lesson: null }).success).toBe(true);
    expect(
      heartbeatResponseSchema.safeParse({
        heartbeatIntervalSeconds: 10,
        lesson: {
          id: id(1),
          overlay: { locked: true, sequence: '42', leaseExpiresAt: '2026-10-28T10:00:00.000Z', leaseSeconds: 120 },
        },
      }).success,
    ).toBe(true);
  });
});
