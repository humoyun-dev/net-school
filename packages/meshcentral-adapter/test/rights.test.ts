import { describe, expect, test } from 'vitest';
import { CONTROL_RIGHTS, rightsFor, VIEW_RIGHTS } from '../src/rights.ts';

describe('rightsFor', () => {
  test('pins the spec values', () => {
    expect(rightsFor('view')).toBe(3848);
    expect(rightsFor('control')).toBe(3592);
    expect(VIEW_RIGHTS).toBe(3848);
    expect(CONTROL_RIGHTS).toBe(3592);
  });

  test.each(['view', 'control'] as const)('%s never grants mesh admin, agent console or remote command', (mode) => {
    const r = rightsFor(mode);
    expect(r & 7).toBe(0);
    expect(r & 16).toBe(0);
    expect(r & 0x20000).toBe(0);
  });

  test('only view mode is view-only', () => {
    expect(rightsFor('view') & 256).not.toBe(0);
    expect(rightsFor('control') & 256).toBe(0);
  });
});
