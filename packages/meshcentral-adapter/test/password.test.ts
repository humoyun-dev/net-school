import { describe, expect, test } from 'vitest';
import { generateMeshPassword } from '../src/password.ts';

describe('generateMeshPassword', () => {
  test('generated password satisfies strict MeshCentral requirements', () => {
    for (let i = 0; i < 2_000; i++) {
      const p = generateMeshPassword();
      expect(p.length).toBeGreaterThanOrEqual(16);
      expect(p.length).toBeLessThanOrEqual(64);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/\W/);
    }
  });

  test('generated passwords are unique', () => {
    expect(new Set(Array.from({ length: 1_000 }, generateMeshPassword)).size).toBe(1_000);
  });
});
