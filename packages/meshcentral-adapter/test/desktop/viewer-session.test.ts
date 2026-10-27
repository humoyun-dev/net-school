import { describe, expect, test } from 'vitest';
import { CookieJar } from '../../src/desktop/cookie-jar.ts';
import { MeshCentralViewerUpstream } from '../../src/desktop/viewer-upstream.ts';
import { AdapterError } from '../../src/errors.ts';
import { FakeRequester } from '../support/fake-requester.ts';

const device = { meshInstanceId: 'mc1', meshDomainId: '', meshNodeId: 'abc' };
const endpoint = { origin: 'https://localhost:1', ca: 'ca' };
const IP = '10.0.0.1';
const CLOSED = { ok: false, reason: 'session_closed' };

function jarWithSession(): CookieJar {
  const jar = new CookieJar();
  jar.absorb(['xid=real-xid; Path=/', 'xid.sig=real-sig; Path=/']);
  return jar;
}

function setup(login: () => Promise<CookieJar> = async () => jarWithSession()) {
  const admin = new FakeRequester();
  const upstream = new MeshCentralViewerUpstream({ admin, endpoint, publicHost: 'gw.test:9443', login });
  const deletes = () => admin.sent.filter((s) => s.action === 'deleteuser').length;
  return { admin, upstream, deletes };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof AdapterError ? err.code : `not-adapter-error: ${String(err)}`;
  }
  return 'resolved';
}

describe('MeshCentralViewerSession revoke', () => {
  test('revoke during an in-flight attach makes attach reject', async () => {
    let finish: (jar: CookieJar) => void = () => {};
    const { upstream } = setup(() => new Promise<CookieJar>((resolve) => (finish = resolve)));
    const session = await upstream.open({ sessionId: 's', actorId: 'a', device, mode: 'view' });

    const attach = session.attach(IP);
    const attached = codeOf(attach);
    const revoked = session.revoke();
    finish(jarWithSession());

    await revoked;
    expect(await attached).toBe('upstream_unavailable');
    expect(session.requestHeaders()).toEqual({});
  });

  test('revoked session exposes no upstream credentials', async () => {
    const { upstream } = setup();
    const session = await upstream.open({ sessionId: 's', actorId: 'a', device, mode: 'control' });
    await session.attach(IP);
    expect(session.requestHeaders().cookie).toContain('real-xid');

    await session.revoke();

    expect(session.requestHeaders()).toEqual({});
    expect(() => session.absorbSetCookie(['xid=new; Path=/'])).not.toThrow();
    expect(session.requestHeaders()).toEqual({});
    expect(session.routeHttp('GET', new URL(`https://gw.test:9443${session.entryPath}`))).toEqual(CLOSED);
    expect(session.routeWs(new URL('wss://gw.test:9443/control.ashx'))).toEqual(CLOSED);
    expect(session.filterFrame('control', 'up', '{"action":"ping"}', false)).toEqual(CLOSED);
    expect(session.filterFrame('control', 'down', '{"action":"ping"}', false)).toEqual(CLOSED);
    expect(session.filterFrame('relay', 'up', '2', false)).toEqual(CLOSED);
    expect(session.filterFrame('relay', 'down', Buffer.from('x'), true)).toEqual(CLOSED);
    expect(await codeOf(session.attach(IP))).toBe('upstream_unavailable');
  });

  test('failed revoke does not re-enable the session and can be retried', async () => {
    const { admin, upstream, deletes } = setup();
    const session = await upstream.open({ sessionId: 's', actorId: 'a', device, mode: 'view' });
    await session.attach(IP);

    admin.replies.set('deleteuser', new AdapterError('upstream_unavailable', 'down'));
    expect(await codeOf(session.revoke())).toBe('upstream_unavailable');
    expect(deletes()).toBe(1);
    expect(await codeOf(session.attach(IP))).toBe('upstream_unavailable');
    expect(session.requestHeaders()).toEqual({});
    expect(session.routeWs(new URL('wss://gw.test:9443/control.ashx'))).toEqual(CLOSED);

    admin.replies.delete('deleteuser');
    await expect(session.revoke()).resolves.toBeUndefined();
    expect(deletes()).toBe(2);
    await expect(session.revoke()).resolves.toBeUndefined();
    expect(deletes()).toBe(2);
  });
});
