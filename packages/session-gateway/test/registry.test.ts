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

  test('closing an unknown session is a no-op', async () => {
    await expect(new SessionRegistry().close('nope', 'revoked')).resolves.toBeUndefined();
  });
});
