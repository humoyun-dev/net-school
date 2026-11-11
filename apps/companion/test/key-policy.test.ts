import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { KeyPolicy, LLKHF_ALTDOWN, LLKHF_INJECTED, VK } from '../src/core/key-policy.ts';

const LCTRL = 0xa2;
const LSHIFT = 0xa0;
const LALT = 0xa4;
const KEY_A = 0x41;
const KEY_C = 0x43;

const down = (vkCode: number, flags = 0) => ({ vkCode, flags, kind: 'down' as const });
const up = (vkCode: number, flags = 0) => ({ vkCode, flags, kind: 'up' as const });

describe('key policy', () => {
  test.each([
    ['Win (left)', [down(VK.LWIN)]],
    ['Win (right)', [down(VK.RWIN)]],
    ['Alt+Tab', [down(LALT), down(VK.TAB)]],
    ['Alt+Esc', [down(LALT), down(VK.ESCAPE)]],
    ['Alt+F4', [down(LALT), down(VK.F4)]],
    ['Alt+Space', [down(LALT), down(VK.SPACE)]],
    ['Ctrl+Esc', [down(LCTRL), down(VK.ESCAPE)]],
    ['Ctrl+Shift+Esc', [down(LCTRL), down(LSHIFT), down(VK.ESCAPE)]],
    ['Ctrl+Alt+Esc', [down(LCTRL), down(LALT), down(VK.ESCAPE)]],
  ])('%s is blocked', (_name, events) => {
    const policy = new KeyPolicy();
    const verdicts = events.map((e) => policy.handle(e));
    expect(verdicts.at(-1)).toBe('block');
  });

  test('Alt flag on the event itself counts even if Alt down was missed', () => {
    expect(new KeyPolicy().handle(down(VK.TAB, LLKHF_ALTDOWN))).toBe('block');
  });

  test.each([
    ['plain letter', [down(KEY_A)]],
    ['Shift+letter', [down(LSHIFT), down(KEY_A)]],
    ['Ctrl+C', [down(LCTRL), down(KEY_C)]],
    ['Tab alone', [down(VK.TAB)]],
    ['Esc alone', [down(VK.ESCAPE)]],
    ['Ctrl+Shift alone', [down(LCTRL), down(LSHIFT)]],
    ['F4 alone', [down(VK.F4)]],
    ['Space alone', [down(VK.SPACE)]],
  ])('%s passes', (_name, events) => {
    const policy = new KeyPolicy();
    expect(events.map((e) => policy.handle(e)).every((v) => v === 'pass')).toBe(true);
  });

  test('releasing a modifier stops the combination from blocking', () => {
    const policy = new KeyPolicy();
    policy.handle(down(LALT));
    expect(policy.handle(down(VK.TAB))).toBe('block');
    policy.handle(up(VK.TAB));
    policy.handle(up(LALT));
    expect(policy.handle(down(VK.TAB))).toBe('pass');
  });

  test('the key-up of a blocked key is swallowed too, so Start does not open', () => {
    const policy = new KeyPolicy();
    expect(policy.handle(down(VK.LWIN))).toBe('block');
    expect(policy.handle(up(VK.LWIN))).toBe('block');
    // Bir marta: keyingi Win-up (down'siz) o'tkaziladi.
    expect(policy.handle(up(VK.LWIN))).toBe('pass');
  });

  test('a key-up whose down was not blocked passes', () => {
    const policy = new KeyPolicy();
    policy.handle(down(KEY_A));
    expect(policy.handle(up(KEY_A))).toBe('pass');
  });

  test('injected input (remote control) is never blocked and does not change modifier state', () => {
    const policy = new KeyPolicy();
    expect(policy.handle(down(VK.LWIN, LLKHF_INJECTED))).toBe('pass');
    expect(policy.handle(up(VK.LWIN, LLKHF_INJECTED))).toBe('pass');
    // Injected Alt jismoniy Tab'ni to'sishga olib kelmaydi.
    policy.handle(down(LALT, LLKHF_INJECTED));
    expect(policy.handle(down(VK.TAB))).toBe('pass');
  });

  test('reset forgets held modifiers and swallowed keys', () => {
    const policy = new KeyPolicy();
    policy.handle(down(LALT));
    policy.handle(down(VK.LWIN));
    policy.reset();
    expect(policy.handle(down(VK.TAB))).toBe('pass');
    expect(policy.handle(up(VK.LWIN))).toBe('pass');
  });
});

// TS ↔ Go vektorlari. Fixture'ni Go helper (native/helper/internal/keys/policy_test.go) ham o'qiydi:
// qoida o'zgarsa bu test yiqiladi va Go porti jim ajralib ketmaydi.
type FixtureEvent = { kind: 'down' | 'up'; vk: number; flags: number } | { kind: 'reset' };
interface FixtureSequence {
  name: string;
  events: FixtureEvent[];
  block: (boolean | null)[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'packages', 'contracts', 'fixtures', 'key-policy.json'),
    'utf8',
  ),
) as { sequences: FixtureSequence[] };

describe('key policy fixture (shared with the Go helper)', () => {
  test('has at least 8 sequences with both blocked and passed outcomes and a reset', () => {
    const sequences = fixture.sequences;
    expect(sequences.length).toBeGreaterThanOrEqual(8);
    expect(new Set(sequences.map((s) => s.name)).size).toBe(sequences.length);
    const verdicts = sequences.flatMap((s) => s.block);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
    expect(sequences.some((s) => s.events.some((e) => e.kind === 'reset'))).toBe(true);
  });

  test.each(fixture.sequences.map((s) => [s.name, s] as const))(
    '%s: block[] matches the TS policy',
    (_name, sequence) => {
      const policy = new KeyPolicy();
      expect(sequence.block).toHaveLength(sequence.events.length);
      const actual = sequence.events.map((event) => {
        if (event.kind === 'reset') {
          policy.reset();
          return null;
        }
        return policy.handle({ vkCode: event.vk, flags: event.flags, kind: event.kind }) === 'block';
      });
      expect(actual).toEqual(sequence.block);
    },
  );
});
