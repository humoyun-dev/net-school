import { capabilityReportSchema } from '@netschool/contracts';
import { describe, expect, test } from 'vitest';
import { capabilityReport, type PlatformFacts } from '../src/core/capabilities.ts';

const facts = (over: Partial<PlatformFacts>): PlatformFacts => ({
  platform: 'win32',
  arch: 'x64',
  sessionType: null,
  screenAccess: 'unknown',
  ...over,
});

describe('capability report', () => {
  test('Windows reports every classroom capability available', () => {
    const report = capabilityReport(facts({ platform: 'win32' }));
    expect(report).toMatchObject({ protocolVersion: 1, os: 'windows', architecture: 'x64', desktopSession: 'windows' });
    for (const key of ['classroom.message', 'classroom.overlay', 'classroom.help', 'classroom.thumbnails']) {
      expect(report.capabilities[key]?.state, key).toBe('available');
    }
  });

  test('overlay is reported as soft', () => {
    expect(capabilityReport(facts({})).capabilities['classroom.overlay']).toEqual({
      state: 'available',
      enforcement: 'soft',
    });
  });

  test('Windows with a working hard lock reports hard enforcement', () => {
    const report = capabilityReport(facts({ hardLock: { enforced: true } }));
    expect(report.capabilities['classroom.overlay']).toEqual({ state: 'available', enforcement: 'hard' });
    expect(capabilityReportSchema.safeParse(report).success).toBe(true);
  });

  test('Windows with a broken hard lock stays available as soft and says why', () => {
    const report = capabilityReport(facts({ hardLock: { enforced: false, reason: 'hook_failed' } }));
    expect(report.capabilities['classroom.overlay']).toEqual({
      state: 'available',
      enforcement: 'soft',
      reason: 'hook_failed',
    });
    expect(capabilityReportSchema.safeParse(report).success).toBe(true);
  });

  test('hard lock facts are ignored outside Windows', () => {
    const report = capabilityReport(facts({ platform: 'darwin', hardLock: { enforced: true } }));
    expect(report.capabilities['classroom.overlay']).toEqual({ state: 'available', enforcement: 'soft' });
  });

  test('macOS without screen access requires permission for thumbnails', () => {
    for (const screenAccess of ['denied', 'not-determined', 'unknown'] as const) {
      const report = capabilityReport(facts({ platform: 'darwin', arch: 'arm64', screenAccess }));
      expect(report.os).toBe('macos');
      expect(report.desktopSession).toBe('macos');
      expect(report.capabilities['classroom.thumbnails'], screenAccess).toEqual({
        state: 'requires_permission',
        provider: 'macos_screen_recording',
      });
      // Qolgan funksiyalar ruxsatga bog'liq emas.
      expect(report.capabilities['classroom.message']?.state).toBe('available');
    }
    const granted = capabilityReport(facts({ platform: 'darwin', screenAccess: 'granted' }));
    expect(granted.capabilities['classroom.thumbnails']?.state).toBe('available');
  });

  test('Wayland thumbnails are unsupported', () => {
    const report = capabilityReport(facts({ platform: 'linux', sessionType: 'wayland' }));
    expect(report).toMatchObject({ os: 'linux', desktopSession: 'wayland' });
    expect(report.capabilities['classroom.thumbnails']).toEqual({
      state: 'unsupported',
      reason: 'wayland_not_certified',
    });
    expect(report.capabilities['classroom.overlay']?.state).toBe('available');
    expect(
      capabilityReport(facts({ platform: 'linux', sessionType: 'x11' })).capabilities['classroom.thumbnails']?.state,
    ).toBe('available');
  });

  test('remote.desktop is never reported by the Companion', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(capabilityReport(facts({ platform })).capabilities['remote.desktop']).toBeUndefined();
    }
  });

  test('every report passes the contracts schema', () => {
    const platforms = ['win32', 'darwin', 'linux', 'freebsd'] as const;
    const sessions = [null, 'x11', 'wayland'] as const;
    const access = ['granted', 'denied', 'not-determined', 'unknown'] as const;
    for (const platform of platforms)
      for (const sessionType of sessions)
        for (const screenAccess of access) {
          const report = capabilityReport(facts({ platform, sessionType, screenAccess }));
          expect(capabilityReportSchema.safeParse(report).success, `${platform}/${sessionType}/${screenAccess}`).toBe(
            true,
          );
        }
    expect(capabilityReport(facts({ platform: 'freebsd' })).os).toBe('other');
  });

  test('web.filter is reported only when the extension state is known', () => {
    expect(capabilityReport(facts({})).capabilities['web.filter']).toBeUndefined();
    expect(capabilityReport(facts({ webFilter: 'available' })).capabilities['web.filter']).toEqual({
      state: 'available',
      provider: 'managed_extension',
    });
    expect(capabilityReport(facts({ webFilter: 'requires_setup' })).capabilities['web.filter']).toEqual({
      state: 'requires_setup',
      provider: 'managed_extension',
      reason: 'extension_missing',
    });
  });
});
