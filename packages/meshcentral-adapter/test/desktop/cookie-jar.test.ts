import { describe, expect, test } from 'vitest';
import { CookieJar } from '../../src/desktop/cookie-jar.ts';

describe('CookieJar', () => {
  test('absorb keeps latest value per name', () => {
    const jar = new CookieJar();
    jar.absorb(['xid=first; Path=/', 'xid.sig=sig1; Path=/']);
    jar.absorb(['xid=second; Path=/']);
    expect(jar.header()).toBe('xid=second; xid.sig=sig1');
    expect(jar.has('xid')).toBe(true);
    expect(jar.has('other')).toBe(false);
  });

  test('absorb ignores attributes and expired cookies (Max-Age=0)', () => {
    const jar = new CookieJar();
    jar.absorb(['a=1; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600', 'b=2; Path=/']);
    jar.absorb(['b=gone; Max-Age=0']);
    jar.absorb(['c=old; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    jar.absorb(['=nameless', 'garbage']);
    expect(jar.header()).toBe('a=1');
    expect(jar.has('b')).toBe(false);
    expect(jar.has('c')).toBe(false);
  });

  test('absorb keeps a value containing equals signs', () => {
    const jar = new CookieJar();
    jar.absorb(['t=abc==; Path=/']);
    expect(jar.header()).toBe('t=abc==');
  });

  test('header joins name=value pairs', () => {
    const jar = new CookieJar();
    expect(jar.header()).toBe('');
    jar.absorb(['a=1', 'b=2', 'c=3']);
    expect(jar.header()).toBe('a=1; b=2; c=3');
  });
});
