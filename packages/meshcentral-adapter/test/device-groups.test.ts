import { describe, expect, test } from 'vitest';
import { agentDownloadPath, ensureDeviceGroup } from '../src/device-groups.ts';
import { FakeRequester } from './support/fake-requester.ts';

describe('device groups', () => {
  test('an existing group is reused, a missing one is created once', async () => {
    const client = new FakeRequester();
    client.replies.set('meshes', {
      action: 'meshes',
      meshes: [{ _id: 'mesh//abc$1', name: 'NetSchool — A', mtype: 2 }],
    });
    expect(await ensureDeviceGroup(client, 'NetSchool — A')).toEqual({ meshid: 'mesh//abc$1' });
    expect(client.sent.map((s) => s.action)).toEqual(['meshes']);
    expect(client.sent[0]?.opts).toMatchObject({ correlate: 'tag' });

    client.replies.set('createmesh', { action: 'createmesh', result: 'ok', meshid: 'mesh//new@2' });
    expect(await ensureDeviceGroup(client, 'NetSchool — B')).toEqual({ meshid: 'mesh//new@2' });
    expect(client.sent.at(-1)).toEqual({ action: 'createmesh', payload: { meshname: 'NetSchool — B', meshtype: 2 } });
  });

  test('a same-named group of another type is not reused', async () => {
    const client = new FakeRequester();
    client.replies.set('meshes', { action: 'meshes', meshes: [{ _id: 'mesh//x', name: 'NetSchool — A', mtype: 1 }] });
    client.replies.set('createmesh', { action: 'createmesh', result: 'ok', meshid: 'mesh//y' });
    expect(await ensureDeviceGroup(client, 'NetSchool — A')).toEqual({ meshid: 'mesh//y' });
  });

  test('download path uses id 4 for x64 and 43 for arm64', () => {
    expect(agentDownloadPath('mesh//a$b@c', 'x64')).toBe('/meshagents?id=4&meshid=a%24b%40c&installflags=0');
    expect(agentDownloadPath('mesh//a$b@c', 'arm64')).toBe('/meshagents?id=43&meshid=a%24b%40c&installflags=0');
    expect(() => agentDownloadPath('mesh/other/x', 'x64')).toThrow(/default domain/);
  });
});
