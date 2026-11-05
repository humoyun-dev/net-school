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
