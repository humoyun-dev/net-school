import { until } from '@netschool/test-support';
import { describe, expect, test } from 'vitest';
import { SessionRegistry } from '../src/registry.ts';
import { FakeSocket, FakeUpstreamSession } from './support/fake-upstream.ts';

function setup() {
  const log: string[] = [];
  const registry = new SessionRegistry();
  const upstream = new FakeUpstreamSession(log);
  const session = registry.add('s1', upstream);
  return { log, registry, upstream, session };
}

describe('SessionRegistry', () => {
  test('byCookie returns the bound session', () => {
    const { registry, session } = setup();
    const cookie = registry.bindCookie('s1');
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(registry.byCookie(cookie)).toBe(session);
    expect(registry.get('s1')).toBe(session);
  });

  test('cookies are unique per binding', () => {
    const { registry } = setup();
    expect(registry.bindCookie('s1')).not.toBe(registry.bindCookie('s1'));
  });

  test('unknown or closed cookie returns undefined', async () => {
    const { registry } = setup();
    const cookie = registry.bindCookie('s1');
    expect(registry.byCookie(undefined)).toBeUndefined();
    expect(registry.byCookie('')).toBeUndefined();
    expect(registry.byCookie('unknown')).toBeUndefined();
    await registry.close('s1', 'revoked');
    expect(registry.byCookie(cookie)).toBeUndefined();
  });

  test('bindCookie rejects unknown and closed sessions', async () => {
    const { registry } = setup();
    expect(() => registry.bindCookie('nope')).toThrow();
    await registry.close('s1', 'revoked');
    expect(() => registry.bindCookie('s1')).toThrow();
  });

  test('add rejects a duplicate session id', () => {
    const { registry } = setup();
    expect(() => registry.add('s1', new FakeUpstreamSession())).toThrow();
  });

  test('close closes sockets with 1008 before revoking upstream', async () => {
    const { log, registry, session } = setup();
    const a = new FakeSocket(log);
    const b = new FakeSocket(log);
    session.sockets.add(a);
    session.sockets.add(b);
    await registry.close('s1', 'revoked');
    expect(log).toEqual(['socket:1008', 'socket:1008', 'revoke']);
    expect(session.closed).toBe(true);
  });

  test('close() closes sockets even when upstream revoke fails', async () => {
    const { registry, upstream, session } = setup();
    const socket = new FakeSocket();
    session.sockets.add(socket);
    const cookie = registry.bindCookie('s1');
    expect(registry.byCookie(cookie)).toBe(session);
    upstream.revokeError = new Error('deleteuser failed');
    await expect(registry.close('s1', 'revoked')).rejects.toThrow('deleteuser failed');
    expect(socket.codes).toEqual([1008]);
    expect(session.closed).toBe(true);
    expect(registry.get('s1')?.closed).toBe(true);
    expect(registry.byCookie(cookie)).toBeUndefined();
  });

  test('close() closes sockets with 1008 within 1 s even when upstream revoke never settles', async () => {
    const { registry, upstream, session } = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    session.sockets.add(a);
    session.sockets.add(b);
    const cookie = registry.bindCookie('s1');
    upstream.revokeHang = true;

    let settled = false;
    void registry.close('s1', 'revoked').finally(() => {
      settled = true;
    });
    await until(() => a.codes.length === 1 && b.codes.length === 1, 1_000);
    expect([a.codes, b.codes]).toEqual([[1008], [1008]]);
    expect(upstream.revokeCalls).toBe(1);
    expect(session.closed).toBe(true);
    expect(registry.byCookie(cookie)).toBeUndefined();
    expect(settled).toBe(false);
  });

  test('a throwing socket does not stop the others or the revoke', async () => {
    const { registry, upstream, session } = setup();
    const good = new FakeSocket();
    session.sockets.add({
      close() {
        throw new Error('already gone');
      },
    });
    session.sockets.add(good);
    await registry.close('s1', 'revoked');
    expect(good.codes).toEqual([1008]);
    expect(upstream.revokeCalls).toBe(1);
  });

  test('close is idempotent', async () => {
    const { registry, upstream, session } = setup();
    const socket = new FakeSocket();
    session.sockets.add(socket);
    await registry.close('s1', 'revoked');
    await registry.close('s1', 'superseded');
    expect(upstream.revokeCalls).toBe(1);
    expect(socket.codes).toEqual([1008]);
  });

  test('concurrent close shares one revoke', async () => {
    const { registry, upstream } = setup();
    await Promise.all([registry.close('s1', 'revoked'), registry.close('s1', 'revoked')]);
    expect(upstream.revokeCalls).toBe(1);
  });

  test('a failed revoke is retried on the next close without reclosing sockets', async () => {
    const { registry, upstream, session } = setup();
    const socket = new FakeSocket();
    session.sockets.add(socket);
    upstream.revokeError = new Error('boom');
    await expect(registry.close('s1', 'revoked')).rejects.toThrow('boom');
    upstream.revokeError = undefined;
    await registry.close('s1', 'revoked');
    expect(upstream.revokeCalls).toBe(2);
    expect(socket.codes).toEqual([1008]);
  });

  test('a revoked session is forgotten and closing it again is a no-op', async () => {
    const { registry, upstream, session } = setup();
    const cookie = registry.bindCookie('s1');
    await registry.close('s1', 'revoked');
    expect(registry.get('s1')).toBeUndefined();
    expect(registry.byCookie(cookie)).toBeUndefined();
    expect(session.closed).toBe(true);
    await expect(registry.close('s1', 'revoked')).resolves.toBeUndefined();
    expect(() => registry.bindCookie('s1')).toThrow();
    expect(upstream.revokeCalls).toBe(1);
  });

  test('a session whose revoke failed is kept for the retry', async () => {
    const { registry, upstream, session } = setup();
    upstream.revokeError = new Error('boom');
    await expect(registry.close('s1', 'revoked')).rejects.toThrow('boom');
    expect(registry.get('s1')).toBe(session);
    upstream.revokeError = undefined;
    await registry.close('s1', 'revoked');
    expect(registry.get('s1')).toBeUndefined();
  });

  test('drop closes sockets and cookies without revoking upstream', async () => {
    const { log, registry, upstream, session } = setup();
    const socket = new FakeSocket(log);
    session.sockets.add(socket);
    const cookie = registry.bindCookie('s1');
    registry.drop('s1');
    registry.drop('s1');
    registry.drop('unknown');
    expect(socket.codes).toEqual([1008]);
    expect(session.closed).toBe(true);
    expect(registry.byCookie(cookie)).toBeUndefined();
    expect(upstream.revokeCalls).toBe(0);
    // Keyingi close() soketlarni qayta yopmaydi, faqat revoke qiladi.
    await registry.close('s1', 'revoked');
    expect(log).toEqual(['socket:1008', 'revoke']);
    expect(registry.get('s1')).toBeUndefined();
  });

  test('closing an unknown session is a no-op', async () => {
    await expect(new SessionRegistry().close('nope', 'revoked')).resolves.toBeUndefined();
  });
});
