import { describe, expect, test } from 'vitest';
import { CONTROL_LEASE_MS, REMOTE_RENEW_INTERVAL_MS, remoteAction } from '../src/index.ts';

describe('remote sessions', () => {
  test('remoteAction maps modes', () => {
    expect(remoteAction('view')).toBe('remote.view');
    expect(remoteAction('control')).toBe('remote.control');
  });

  test('renew interval fits several times into the control lease', () => {
    expect(CONTROL_LEASE_MS).toBe(30_000);
    expect(REMOTE_RENEW_INTERVAL_MS).toBe(10_000);
    expect(REMOTE_RENEW_INTERVAL_MS).toBeLessThan(CONTROL_LEASE_MS);
  });
});
