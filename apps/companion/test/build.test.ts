import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const script = join(import.meta.dirname, '..', 'scripts', 'build.mjs');

function build(testBuild: boolean): string {
  const out = mkdtempSync(join(tmpdir(), 'ns-build-'));
  const res = spawnSync(process.execPath, [script], {
    env: { ...process.env, NETSCHOOL_COMPANION_OUT: out, NETSCHOOL_COMPANION_TEST_BUILD: testBuild ? '1' : '' },
    encoding: 'utf8',
  });
  expect(res.status, res.stderr).toBe(0);
  return readFileSync(join(out, 'main.cjs'), 'utf8');
}

describe('companion build', () => {
  // O'quvchi muhit o'zgaruvchisi bilan overlay'ni yashira olmasligi uchun yashirin rejim oddiy build'da umuman yo'q.
  test('a normal build carries no hidden test mode', () => {
    expect(build(false)).not.toContain('NETSCHOOL_COMPANION_TEST_HIDDEN');
  }, 60_000);

  test('only the e2e test build can hide windows', () => {
    expect(build(true)).toContain('NETSCHOOL_COMPANION_TEST_HIDDEN');
  }, 60_000);
});
