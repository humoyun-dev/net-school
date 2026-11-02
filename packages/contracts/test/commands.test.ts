import { describe, expect, test } from 'vitest';
import {
  eventsResponseSchema,
  heartbeatResponseSchema,
  idempotencyKeySchema,
  issueCommandRequestSchema,
  receiptRequestSchema,
} from '../src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const lesson = () => ({
  id: id(1),
  overlay: { locked: true, sequence: '42', leaseExpiresAt: '2026-10-28T10:00:00.000Z', leaseSeconds: 120 },
  thumbnails: { intervalMs: 1000, maxWidth: 480 },
  helpRequest: null as { id: string; raisedAt: string } | null,
});

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
        lesson: lesson(),
      }).success,
    ).toBe(true);
  });

  test('heartbeat lesson requires thumbnails and helpRequest fields', () => {
    const { thumbnails: _t, ...noThumbnails } = lesson();
    const { helpRequest: _h, ...noHelp } = lesson();
    for (const bad of [noThumbnails, noHelp]) {
      expect(heartbeatResponseSchema.safeParse({ heartbeatIntervalSeconds: 10, lesson: bad }).success).toBe(false);
    }
    const ok = (l: unknown) => heartbeatResponseSchema.safeParse({ heartbeatIntervalSeconds: 10, lesson: l }).success;
    expect(
      ok({ ...lesson(), thumbnails: null, helpRequest: { id: id(2), raisedAt: '2026-11-02T10:00:00.000Z' } }),
    ).toBe(true);
    expect(ok({ ...lesson(), thumbnails: { intervalMs: 1000, maxWidth: 481 } })).toBe(false);
    expect(ok({ ...lesson(), thumbnails: { intervalMs: 1000, maxWidth: 159 } })).toBe(false);
    expect(ok({ ...lesson(), thumbnails: { intervalMs: 0, maxWidth: 480 } })).toBe(false);
  });

  test('events carry help request types and snapshot', () => {
    const request = {
      id: id(2),
      lessonId: id(1),
      deviceId: id(3),
      raisedAt: '2026-11-02T10:00:00.000Z',
      clearedAt: null,
      clearReason: null,
    };
    const event = (type: string) => ({ seq: '1', type, at: '2026-11-02T10:00:00.000Z', lessonId: id(1), data: {} });
    for (const type of ['help_request.raised', 'help_request.cleared'])
      expect(eventsResponseSchema.safeParse({ cursor: '1', resync: false, events: [event(type)] }).success, type).toBe(
        true,
      );
    expect(
      eventsResponseSchema.safeParse({
        cursor: '1',
        resync: true,
        snapshot: { lesson: null, commands: [], remoteSessions: [], helpRequests: [request] },
        events: [],
      }).success,
    ).toBe(true);
    expect(
      eventsResponseSchema.safeParse({
        cursor: '1',
        resync: true,
        snapshot: { lesson: null, commands: [], remoteSessions: [] },
        events: [],
      }).success,
    ).toBe(false);
  });
});
