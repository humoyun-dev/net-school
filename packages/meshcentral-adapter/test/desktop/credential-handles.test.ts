import { describe, expect, test } from 'vitest';
import { CredentialHandles } from '../../src/desktop/credential-handles.ts';

describe('CredentialHandles', () => {
  test('remember returns distinct nsh_ handles', () => {
    const handles = new CredentialHandles();
    const a = handles.remember('auth', 'real-a');
    const b = handles.remember('auth', 'real-b');
    const c = handles.remember('relay', 'real-a');
    expect(a).toMatch(/^nsh_[A-Za-z0-9_-]{32}$/);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(handles.resolve('auth', a)).toBe('real-a');
    expect(handles.resolve('relay', c)).toBe('real-a');
  });

  test('resolve is scoped by kind', () => {
    const handles = new CredentialHandles();
    const a = handles.remember('auth', 'real-a');
    expect(handles.resolve('relay', a)).toBeUndefined();
    expect(handles.resolve('auth', 'nsh_unknown')).toBeUndefined();
    expect(handles.resolve('auth', 'real-a')).toBeUndefined();
  });

  test('resolve keeps the previous pair after one refresh and forgets after two', () => {
    const handles = new CredentialHandles();
    const h1 = handles.remember('auth', 'real-1');
    const h2 = handles.remember('auth', 'real-2');
    expect(handles.resolve('auth', h1)).toBe('real-1');
    expect(handles.resolve('auth', h2)).toBe('real-2');
    const h3 = handles.remember('auth', 'real-3');
    expect(handles.resolve('auth', h1)).toBeUndefined();
    expect(handles.resolve('auth', h2)).toBe('real-2');
    expect(handles.resolve('auth', h3)).toBe('real-3');
    expect(handles.reals()).toEqual(['real-2', 'real-3']);
  });

  test('kinds rotate independently and reals() lists both', () => {
    const handles = new CredentialHandles();
    const auth = handles.remember('auth', 'a1');
    handles.remember('relay', 'r1');
    handles.remember('relay', 'r2');
    handles.remember('relay', 'r3');
    expect(handles.resolve('auth', auth)).toBe('a1');
    expect([...handles.reals()].sort()).toEqual(['a1', 'r2', 'r3']);
  });

  test('remember rejects an empty real value', () => {
    expect(() => new CredentialHandles().remember('auth', '')).toThrow();
  });
});
