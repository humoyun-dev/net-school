import { describe, expect, test } from 'vitest';
import { AdapterError } from '../src/errors.ts';
import { MeshCentralPrincipals, SESSION_PRINCIPAL_PREFIX } from '../src/principals.ts';
import { FakeRequester } from './support/fake-requester.ts';

const SESSION_ID = '0b9f6c1e-3c1d-4f0e-9a52-7d1f2a3b4c5d';
const device = { meshInstanceId: 'mc1', meshDomainId: '', meshNodeId: 'abc' };

describe('MeshCentralPrincipals', () => {
  test('create sends adduser with locked site rights then adddeviceuser with view rights', async () => {
    const client = new FakeRequester();
    const principal = await new MeshCentralPrincipals(client).create(device, 'view', SESSION_ID);

    expect(principal.username).toBe(`ns-sess-${SESSION_ID}`);
    expect(principal.userId).toBe(`user//${principal.username}`);
    expect(principal.password.length).toBeGreaterThanOrEqual(40);
    expect(principal).toMatchObject({ nodeId: 'node//abc', rights: 12586760 });
    expect(client.sent).toEqual([
      {
        action: 'adduser',
        payload: { username: principal.username, pass: principal.password, siteadmin: 5184 },
      },
      { action: 'adddeviceuser', payload: { userids: [principal.userId], nodeid: 'node//abc', rights: 12586760 } },
    ]);
  });

  test('principal username carries the session id', async () => {
    const principal = await new MeshCentralPrincipals(new FakeRequester()).create(device, 'view', 'Abc-123');
    expect(principal.username).toBe(`${SESSION_PRINCIPAL_PREFIX}Abc-123`);
    // MeshCentral user id'dagi nomni kichik harfga o'tkazadi.
    expect(principal.userId).toBe('user//ns-sess-abc-123');
  });

  test.each(['', 'a/b', 'a b', '../x', 'a_b', 'x'.repeat(65), 'é'])(
    'create rejects session id %j with TypeError before any request',
    async (bad) => {
      const client = new FakeRequester();
      await expect(new MeshCentralPrincipals(client).create(device, 'view', bad)).rejects.toBeInstanceOf(TypeError);
      expect(client.sent).toEqual([]);
    },
  );

  test('listing ignores users without the prefix', async () => {
    const client = new FakeRequester();
    client.replies.set('users', {
      action: 'users',
      users: [
        { _id: 'user//admin', name: 'admin' },
        { _id: 'user//ns-sess-aaa', name: 'ns-sess-aaa' },
        { _id: 'user//other-ns-sess-bbb', name: 'other-ns-sess-bbb' },
        { _id: 'user//ns-sess-', name: 'ns-sess-' },
        { _id: 'user//ns-sess-Bbb', name: 'ns-sess-Bbb' },
      ],
    });
    expect(await new MeshCentralPrincipals(client).listSessionPrincipals()).toEqual([
      { userId: 'user//ns-sess-aaa', sessionId: 'aaa' },
      { userId: 'user//ns-sess-Bbb', sessionId: 'Bbb' },
    ]);
    expect(client.sent).toEqual([{ action: 'users', payload: {}, opts: { correlate: 'tag' } }]);
  });

  test('listing returns nothing when the reply has no users', async () => {
    const client = new FakeRequester();
    client.replies.set('users', { action: 'users' });
    expect(await new MeshCentralPrincipals(client).listSessionPrincipals()).toEqual([]);
  });

  test('create uses control rights in control mode', async () => {
    const client = new FakeRequester();
    expect((await new MeshCentralPrincipals(client).create(device, 'control', SESSION_ID)).rights).toBe(12586504);
  });

  test('create compensates with deleteuser when the grant fails', async () => {
    const client = new FakeRequester();
    const grantError = new AdapterError('upstream_rejected', 'rejected', 'Invalid rights');
    client.replies.set('adddeviceuser', grantError);
    await expect(new MeshCentralPrincipals(client).create(device, 'view', SESSION_ID)).rejects.toBe(grantError);
    const [, grant] = client.sent;
    const userid = (grant?.payload.userids as string[] | undefined)?.[0];
    expect(userid).toMatch(/^user\/\/ns-sess-/);
    expect(client.sent.map((s) => s.action)).toEqual(['adduser', 'adddeviceuser', 'deleteuser']);
    expect(client.sent[2]?.payload).toEqual({ userid });
  });

  test('revoke is idempotent', async () => {
    const client = new FakeRequester();
    const principals = new MeshCentralPrincipals(client);
    await principals.revoke('user//ns-sess-x');
    client.replies.set('deleteuser', new AdapterError('upstream_rejected', 'rejected', 'User does not exists'));
    await expect(principals.revoke('user//ns-sess-x')).resolves.toBeUndefined();
    expect(client.sent).toEqual([
      { action: 'deleteuser', payload: { userid: 'user//ns-sess-x' } },
      { action: 'deleteuser', payload: { userid: 'user//ns-sess-x' } },
    ]);
  });

  test('revoke surfaces other failures', async () => {
    const client = new FakeRequester();
    client.replies.set('deleteuser', new AdapterError('upstream_rejected', 'rejected', 'Permission denied'));
    await expect(new MeshCentralPrincipals(client).revoke('user//x')).rejects.toBeInstanceOf(AdapterError);
  });
});
