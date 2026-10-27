import { expect, test } from 'vitest';

test('domain entry point loads', async () => {
  expect(typeof (await import('../src/index.ts'))).toBe('object');
});
