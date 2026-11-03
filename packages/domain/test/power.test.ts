import { describe, expect, test } from 'vitest';
import {
  isValidTimezone,
  judgePowerTarget,
  nextOccurrence,
  POWER_FORCE_AFTER_MS,
  type PowerObservation,
  powerPlatform,
  shouldForcePowerTarget,
} from '../src/index.ts';

const T0 = 1_000_000;
const online: PowerObservation = { agentOnline: true, powerState: 'on' };
const offline: PowerObservation = { agentOnline: false, powerState: 'unknown' };
const fresh = { sentAt: T0, offlineSeenAt: null };

describe('judgePowerTarget', () => {
  test('shutdown succeeds when the agent goes offline', () => {
    expect(judgePowerTarget('shutdown', fresh, online, T0 + 5_000).status).toBe('sent');
    expect(judgePowerTarget('shutdown', fresh, offline, T0 + 5_000).status).toBe('succeeded');
    expect(judgePowerTarget('shutdown', fresh, { agentOnline: true, powerState: 'off' }, T0 + 5_000).status).toBe(
      'succeeded',
    );
  });

  test('sleep succeeds on powerState sleep while still connected', () => {
    expect(judgePowerTarget('sleep', fresh, { agentOnline: true, powerState: 'sleep' }, T0 + 1).status).toBe(
      'succeeded',
    );
    expect(judgePowerTarget('sleep', fresh, offline, T0 + 1).status).toBe('succeeded');
    expect(judgePowerTarget('sleep', fresh, online, T0 + 1).status).toBe('sent');
  });

  test('reboot needs offline then online', () => {
    expect(judgePowerTarget('reboot', fresh, online, T0 + 5_000)).toEqual({ status: 'sent', offlineSeenAt: null });
    const down = judgePowerTarget('reboot', fresh, offline, T0 + 10_000);
    expect(down).toEqual({ status: 'sent', offlineSeenAt: T0 + 10_000 });
    const again = judgePowerTarget('reboot', { sentAt: T0, offlineSeenAt: down.offlineSeenAt }, offline, T0 + 15_000);
    expect(again.offlineSeenAt).toBe(T0 + 10_000);
    expect(judgePowerTarget('reboot', { sentAt: T0, offlineSeenAt: T0 + 10_000 }, online, T0 + 40_000)).toEqual({
      status: 'succeeded',
      offlineSeenAt: T0 + 10_000,
    });
  });

  test('wake succeeds when the agent comes online', () => {
    expect(judgePowerTarget('wake', fresh, offline, T0 + 1).status).toBe('sent');
    expect(judgePowerTarget('wake', fresh, online, T0 + 1).status).toBe('succeeded');
  });

  test('a missing node waits until the deadline then is unknown', () => {
    expect(judgePowerTarget('shutdown', fresh, null, T0 + 179_999).status).toBe('sent');
    expect(judgePowerTarget('shutdown', fresh, null, T0 + 180_000).status).toBe('unknown');
  });

  test('deadline is per type', () => {
    expect(judgePowerTarget('reboot', fresh, online, T0 + 599_999).status).toBe('sent');
    expect(judgePowerTarget('reboot', fresh, online, T0 + 600_000).status).toBe('unknown');
    expect(judgePowerTarget('wake', fresh, offline, T0 + 299_999).status).toBe('sent');
    expect(judgePowerTarget('wake', fresh, offline, T0 + 300_000).status).toBe('unknown');
    expect(judgePowerTarget('sleep', fresh, online, T0 + 180_000).status).toBe('unknown');
  });
});

describe('nextOccurrence', () => {
  const weekdays = { daysOfWeek: [1, 2, 3, 4, 5], timeOfDay: '19:00', timezone: 'Asia/Tashkent' };

  test('Asia/Tashkent Mon–Fri 19:00 from Monday 18:00 local', () => {
    expect(nextOccurrence(weekdays, Date.parse('2026-11-02T13:00:00Z'))).toBe(Date.parse('2026-11-02T14:00:00Z'));
  });

  test('exactly at the occurrence moves to the next working day', () => {
    expect(nextOccurrence(weekdays, Date.parse('2026-11-06T14:00:00Z'))).toBe(Date.parse('2026-11-09T14:00:00Z'));
  });

  test('DST gap shifts forward', () => {
    const daily = { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], timeOfDay: '02:30', timezone: 'Europe/Berlin' };
    expect(nextOccurrence(daily, Date.parse('2027-03-28T00:00:00Z'))).toBe(Date.parse('2027-03-28T01:30:00Z'));
  });

  test('a normal Berlin evening uses the summer offset', () => {
    const sun = { daysOfWeek: [7], timeOfDay: '20:15', timezone: 'Europe/Berlin' };
    expect(nextOccurrence(sun, Date.parse('2027-06-01T00:00:00Z'))).toBe(Date.parse('2027-06-06T18:15:00Z'));
  });

  test('timezones are validated', () => {
    expect(isValidTimezone('Mars/Base')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Asia/Tashkent')).toBe(true);
  });
});

// Yumshoq o'chirishni Windows dasturi to'sib qo'ysa: 60 s dan keyin ham onlayn bo'lsa majburiy bosqich (P0c topilmasi).
describe('shouldForcePowerTarget', () => {
  const pending = { sentAt: T0, offlineSeenAt: null, forcedAt: null };
  const late = T0 + POWER_FORCE_AFTER_MS;

  test('shutdown and reboot are forced once the agent is still online after 60 s', () => {
    expect(POWER_FORCE_AFTER_MS).toBe(60_000);
    expect(shouldForcePowerTarget('shutdown', pending, online, late - 1)).toBe(false);
    expect(shouldForcePowerTarget('shutdown', pending, online, late)).toBe(true);
    expect(shouldForcePowerTarget('reboot', pending, online, late)).toBe(true);
  });

  test('never forced twice, never for sleep or wake, never without a live agent', () => {
    expect(shouldForcePowerTarget('shutdown', { ...pending, forcedAt: late }, online, late + 5_000)).toBe(false);
    expect(shouldForcePowerTarget('sleep', pending, online, late)).toBe(false);
    expect(shouldForcePowerTarget('wake', pending, online, late)).toBe(false);
    expect(shouldForcePowerTarget('shutdown', pending, offline, late)).toBe(false);
    expect(shouldForcePowerTarget('shutdown', pending, null, late)).toBe(false);
    expect(shouldForcePowerTarget('shutdown', pending, { agentOnline: true, powerState: 'off' }, late)).toBe(false);
  });

  test('a reboot that already went offline is not forced', () => {
    expect(shouldForcePowerTarget('reboot', { ...pending, offlineSeenAt: T0 + 10_000 }, online, late)).toBe(false);
  });
});

describe('powerPlatform', () => {
  test('picks the forced command family from the MeshCentral OS description', () => {
    expect(powerPlatform('Microsoft Windows 11 Pro - 23H2/22631')).toBe('windows');
    expect(powerPlatform('Ubuntu 24.04 LTS')).toBe('posix');
    expect(powerPlatform('macOS Sequoia 15.1')).toBe('posix');
    expect(powerPlatform(null)).toBeNull();
    expect(powerPlatform('  ')).toBeNull();
  });
});
