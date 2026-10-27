import { describe, expect, test } from 'vitest';
import { AdapterError } from '../src/errors.ts';
import { MeshCentralPrincipals } from '../src/principals.ts';
import { FakeRequester } from './support/fake-requester.ts';

const device = { meshInstanceId: 'mc1', meshDomainId: '', meshNodeId: 'abc' };

describe('MeshCentralPrincipals', () => {
  test('create sends adduser with locked site rights then adddeviceuser with view rights', async () => {
    const client = new FakeRequester();
    const principal = await new MeshCentralPrincipals(client).create(device, 'view');

    expect(principal.username).toMatch(/^ns-sess-[0-9a-f-]{36}$/);
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

  test('create uses control rights in control mode', async () => {
    const client = new FakeRequester();
    expect((await new MeshCentralPrincipals(client).create(device, 'control')).rights).toBe(12586504);
  });

  test('create compensates with deleteuser when the grant fails', async () => {
    const client = new FakeRequester();
    const grantError = new AdapterError('upstream_rejected', 'rejected', 'Invalid rights');
    client.replies.set('adddeviceuser', grantError);
    await expect(new MeshCentralPrincipals(client).create(device, 'view')).rejects.toBe(grantError);
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
