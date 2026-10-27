import { describe, expect, test } from 'vitest';
import { CONTROL_RIGHTS, rightsFor, VIEW_RIGHTS } from '../src/rights.ts';

describe('rightsFor', () => {
  test('pins the spec values', () => {
    expect(rightsFor('view')).toBe(0xc00f08);
    expect(rightsFor('control')).toBe(0xc00e08);
    expect(VIEW_RIGHTS).toBe(12586760);
    expect(CONTROL_RIGHTS).toBe(12586504);
  });

  test.each(['view', 'control'] as const)('%s never grants mesh admin, agent console or remote command', (mode) => {
    const r = rightsFor(mode);
    expect(r & 7).toBe(0);
    expect(r & 16).toBe(0);
    expect(r & 0x20000).toBe(0);
  });

  test.each(['view', 'control'] as const)('%s blocks terminal, files, AMT, registry and software tunnels', (mode) => {
    const r = rightsFor(mode);
    for (const bit of [0x200, 0x400, 0x800, 0x400000, 0x800000]) expect(r & bit).toBe(bit);
  });

  test('only view mode is view-only', () => {
    expect(rightsFor('view') & 256).not.toBe(0);
    expect(rightsFor('control') & 256).toBe(0);
  });
});
