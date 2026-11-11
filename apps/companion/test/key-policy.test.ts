import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { KeyPolicy, LLKHF_ALTDOWN, LLKHF_INJECTED, LLKHF_LOWER_IL_INJECTED, VK } from '../src/core/key-policy.ts';

const LCTRL = 0xa2;
const LSHIFT = 0xa0;
const LALT = 0xa4;
const KEY_A = 0x41;
const KEY_C = 0x43;
// Pastroq ishonchlilik darajasidagi jarayon yuborgan kiritish: Windows INJECTED va LOWER_IL_INJECTED'ni birga qo'yadi.
const LOWER_IL = LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED;

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

  test('injected Alt without the lower-integrity flag does not make an injected Tab blocked', () => {
    const policy = new KeyPolicy();
    policy.handle(down(LALT, LLKHF_INJECTED));
    expect(policy.handle(down(VK.TAB, LLKHF_INJECTED))).toBe('pass');
  });

  test.each([
    ['Win (left)', [down(VK.LWIN, LOWER_IL)]],
    ['Win (right)', [down(VK.RWIN, LOWER_IL)]],
    ['Alt+Tab', [down(LALT, LOWER_IL), down(VK.TAB, LOWER_IL)]],
    ['Alt+F4', [down(LALT, LOWER_IL), down(VK.F4, LOWER_IL)]],
    ['Ctrl+Esc', [down(LCTRL, LOWER_IL), down(VK.ESCAPE, LOWER_IL)]],
    ['Alt+Tab with a physical Alt', [down(LALT), down(VK.TAB, LOWER_IL)]],
    ['Tab with the Alt flag on the event', [down(VK.TAB, LOWER_IL | LLKHF_ALTDOWN)]],
    ['Win with only the lower-integrity flag', [down(VK.LWIN, LLKHF_LOWER_IL_INJECTED)]],
  ])('%s injected by a lower-integrity process is blocked like physical input', (_name, events) => {
    const policy = new KeyPolicy();
    expect(events.map((e) => policy.handle(e)).at(-1)).toBe('block');
  });

  test('a lower-integrity injected Win swallows its key-up, an injected Alt is tracked as a modifier', () => {
    const policy = new KeyPolicy();
    expect(policy.handle(down(VK.LWIN, LOWER_IL))).toBe('block');
    expect(policy.handle(up(VK.LWIN, LOWER_IL))).toBe('block');
    expect(policy.handle(up(VK.LWIN))).toBe('pass');
    policy.handle(down(LALT, LOWER_IL));
    expect(policy.handle(down(VK.TAB))).toBe('block');
    policy.handle(up(VK.TAB));
    policy.handle(up(LALT, LOWER_IL));
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
  test('has at least 40 sequences with both blocked and passed outcomes, a reset and lower-integrity injection', () => {
    const sequences = fixture.sequences;
    expect(sequences.length).toBeGreaterThanOrEqual(40);
    expect(new Set(sequences.map((s) => s.name)).size).toBe(sequences.length);
    const verdicts = sequences.flatMap((s) => s.block);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
    expect(sequences.some((s) => s.events.some((e) => e.kind === 'reset'))).toBe(true);
    // Pastroq darajadagi injected hodisa to'siladi, oddiy injected esa o'tadi: ikkalasi ham fixture'da bo'lishi shart.
    const flagged = sequences.flatMap((s) => s.events.map((e, i) => ({ e, verdict: s.block[i] })));
    const hasInjected = (mask: number, wanted: boolean) =>
      flagged.some(
        ({ e, verdict }) => e.kind !== 'reset' && (e.flags & 0x12) === mask && e.kind === 'down' && verdict === wanted,
      );
    expect(hasInjected(0x12, true)).toBe(true);
    expect(hasInjected(0x10, false)).toBe(true);
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
