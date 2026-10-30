import { describe, expect, test } from 'vitest';
import {
  eventsResponseSchema,
  openRemoteSessionRequestSchema,
  remoteSessionSchema,
  remoteTicketSchema,
  renewRemoteSessionRequestSchema,
} from '../src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-30T10:00:00.000Z';

const session = {
  id: id(1),
  lessonId: id(2),
  deviceId: id(3),
  actorUserId: id(4),
  mode: 'control',
  status: 'active',
  openedAt: at,
  expiresAt: '2026-10-30T10:00:30.000Z',
  closedAt: null,
  closeReason: null,
  lease: { fencing: '42', expiresAt: '2026-10-30T10:00:30.000Z' },
};

describe('remote session contracts', () => {
  test('mode must be view or control', () => {
    expect(openRemoteSessionRequestSchema.safeParse({ deviceId: id(3), mode: 'view' }).success).toBe(true);
    expect(openRemoteSessionRequestSchema.safeParse({ deviceId: id(3), mode: 'control' }).success).toBe(true);
    expect(openRemoteSessionRequestSchema.safeParse({ deviceId: id(3), mode: 'shell' }).success).toBe(false);
    expect(openRemoteSessionRequestSchema.safeParse({ deviceId: id(3) }).success).toBe(false);
    expect(openRemoteSessionRequestSchema.safeParse({ deviceId: 'not-a-uuid', mode: 'view' }).success).toBe(false);
  });

  test('unknown fields are rejected', () => {
    expect(openRemoteSessionRequestSchema.safeParse({ deviceId: id(3), mode: 'view', extra: 1 }).success).toBe(false);
    expect(renewRemoteSessionRequestSchema.safeParse({ fencing: '1', extra: 1 }).success).toBe(false);
  });

  test('fencing is a decimal string', () => {
    expect(renewRemoteSessionRequestSchema.safeParse({}).success).toBe(true);
    expect(renewRemoteSessionRequestSchema.safeParse({ fencing: '0' }).success).toBe(true);
    expect(renewRemoteSessionRequestSchema.safeParse({ fencing: '9223372036854775807' }).success).toBe(true);
    expect(renewRemoteSessionRequestSchema.safeParse({ fencing: '1'.repeat(20) }).success).toBe(false);
    expect(renewRemoteSessionRequestSchema.safeParse({ fencing: '' }).success).toBe(false);
    expect(renewRemoteSessionRequestSchema.safeParse({ fencing: '-1' }).success).toBe(false);
    expect(renewRemoteSessionRequestSchema.safeParse({ fencing: '1.5' }).success).toBe(false);
    expect(renewRemoteSessionRequestSchema.safeParse({ fencing: 7 }).success).toBe(false);
  });

  test('session carries status, close reason and lease', () => {
    expect(remoteSessionSchema.safeParse(session).success).toBe(true);
    const closed = { ...session, status: 'closed', closedAt: at, closeReason: 'lease_expired', lease: null };
    expect(remoteSessionSchema.safeParse(closed).success).toBe(true);
    expect(remoteSessionSchema.safeParse({ ...session, status: 'paused' }).success).toBe(false);
    expect(remoteSessionSchema.safeParse({ ...session, closeReason: 'because' }).success).toBe(false);
    expect(remoteSessionSchema.safeParse({ ...session, lease: { fencing: '42' } }).success).toBe(false);
  });

  test('ticket url must be https', () => {
    expect(remoteTicketSchema.safeParse({ url: 'https://mesh.example.uz/desk?t=abc', expiresAt: at }).success).toBe(
      true,
    );
    expect(remoteTicketSchema.safeParse({ url: 'http://mesh.example.uz/desk', expiresAt: at }).success).toBe(false);
    expect(remoteTicketSchema.safeParse({ url: 'javascript:alert(1)', expiresAt: at }).success).toBe(false);
    expect(remoteTicketSchema.safeParse({ url: 'not a url', expiresAt: at }).success).toBe(false);
  });

  test('snapshot carries remote sessions', () => {
    const response = {
      cursor: '5',
      resync: true,
      snapshot: { lesson: null, commands: [], remoteSessions: [session] },
      events: [
        { seq: '4', type: 'remote_session.opened', at, lessonId: id(2), data: {} },
        { seq: '5', type: 'remote_session.closed', at, lessonId: id(2), data: { reason: 'teacher' } },
      ],
    };
    expect(eventsResponseSchema.safeParse(response).success).toBe(true);
    expect(eventsResponseSchema.safeParse({ ...response, snapshot: { lesson: null, commands: [] } }).success).toBe(
      false,
    );
  });
});
