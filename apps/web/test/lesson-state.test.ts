import type { Command, EventsResponse, Lesson } from '@netschool/contracts';
import { describe, expect, test } from 'vitest';
import { applyCommand, applyPage, emptyLessonState, latestResultFor } from '../src/classroom/lesson-state.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-02T10:00:00.000Z';
const lesson: Lesson = {
  id: id(1),
  siteId: id(2),
  roomId: id(3),
  teacherUserId: id(4),
  title: 'Matematika',
  status: 'active',
  startedAt: AT,
  scheduledEndAt: AT,
  endedAt: null,
  endReason: null,
  deviceIds: [id(10), id(11)],
};
const command = (n: number, seq: string, statuses: [string, string][]): Command => ({
  id: id(n),
  lessonId: lesson.id,
  type: 'message.show',
  sequence: seq,
  issuedAt: AT,
  expiresAt: AT,
  targets: statuses.map(([deviceId, status]) => ({
    deviceId,
    status: status as Command['targets'][number]['status'],
    reason: null,
    updatedAt: AT,
  })),
  summary: {} as Command['summary'],
});
const ev = (seq: number, type: EventsResponse['events'][number]['type'], data: Record<string, unknown>) => ({
  seq: String(seq),
  type,
  at: AT,
  lessonId: lesson.id,
  data,
});
const snapshotPage = (
  cursor: string,
  extra: Partial<NonNullable<EventsResponse['snapshot']>> = {},
): EventsResponse => ({
  cursor,
  resync: true,
  snapshot: { lesson, commands: [], remoteSessions: [], helpRequests: [], ...extra },
  events: [],
});

describe('lesson state', () => {
  test('a resync rebuilds state from the snapshot', () => {
    let s = applyPage(emptyLessonState(), snapshotPage('5', { commands: [command(20, '1', [[id(10), 'sent']])] }));
    s = applyPage(s, {
      cursor: '6',
      resync: false,
      events: [ev(6, 'help_request.raised', { helpRequestId: id(30), deviceId: id(10) })],
    });
    expect(s.help.size).toBe(1);
    // Hub qayta ishga tushdi: yangi snapshot eski holatni to'liq almashtiradi.
    s = applyPage(s, snapshotPage('2', { commands: [] }));
    expect(s.lesson?.id).toBe(lesson.id);
    expect(s.commands.size).toBe(0);
    expect(s.help.size).toBe(0);
    expect(s.cursor).toBe('2');
  });

  test('a duplicate event after resync is ignored', () => {
    let s = applyPage(emptyLessonState(), snapshotPage('5'));
    const raised = ev(6, 'help_request.raised', { helpRequestId: id(30), deviceId: id(10) });
    const cleared = ev(7, 'help_request.cleared', { helpRequestId: id(30), deviceId: id(10), reason: 'teacher' });
    s = applyPage(s, { cursor: '7', resync: false, events: [raised, cleared] });
    expect(s.help.size).toBe(0);
    s = applyPage(s, { cursor: '7', resync: false, events: [raised] });
    expect(s.help.size).toBe(0);
    expect(s.lastSeq).toBe(7);
  });

  test('command target updates fill the per-device results', () => {
    let s = applyPage(emptyLessonState(), snapshotPage('5'));
    s = applyPage(s, {
      cursor: '6',
      resync: false,
      events: [ev(6, 'command.created', { commandId: id(20), type: 'message.show', targets: 2, pending: 2 })],
    });
    expect(s.missingCommands).toEqual([id(20)]);
    s = applyCommand(
      s,
      command(20, '9', [
        [id(10), 'pending'],
        [id(11), 'pending'],
      ]),
    );
    expect(s.missingCommands).toEqual([]);
    s = applyPage(s, {
      cursor: '8',
      resync: false,
      events: [
        ev(7, 'command.target_updated', { commandId: id(20), deviceId: id(10), status: 'succeeded' }),
        ev(8, 'command.target_updated', { commandId: id(20), deviceId: id(11), status: 'failed' }),
      ],
    });
    expect(latestResultFor(s, id(10))).toMatchObject({ commandId: id(20), status: 'succeeded' });
    expect(latestResultFor(s, id(11))).toMatchObject({ status: 'failed' });
    expect(s.commands.get(id(20))?.summary).toMatchObject({ succeeded: 1, failed: 1 });
  });

  test('help raised and cleared events toggle the tile badge', () => {
    let s = applyPage(
      emptyLessonState(),
      snapshotPage('1', {
        helpRequests: [
          { id: id(30), lessonId: lesson.id, deviceId: id(10), raisedAt: AT, clearedAt: null, clearReason: null },
        ],
      }),
    );
    expect([...s.help.values()].map((h) => h.deviceId)).toEqual([id(10)]);
    s = applyPage(s, {
      cursor: '2',
      resync: false,
      events: [ev(2, 'help_request.cleared', { helpRequestId: id(30), deviceId: id(10) })],
    });
    expect(s.help.size).toBe(0);
  });

  test('lesson ended and started events update the lesson', () => {
    let s = applyPage(emptyLessonState(), snapshotPage('1'));
    s = applyPage(s, { cursor: '2', resync: false, events: [ev(2, 'lesson.ended', { reason: 'teacher' })] });
    expect(s.lesson?.status).toBe('ended');
    s = applyPage(s, {
      cursor: '3',
      resync: false,
      events: [ev(3, 'lesson.started', { teacherUserId: id(4), deviceIds: [] })],
    });
    expect(s.needsLesson).toBe(true);
  });
});
