import type { DeviceEvent } from '@netschool/domain';
import { describe, expect, test } from 'vitest';
import { MeshCentralDeviceManagement } from '../src/device-management.ts';
import { AdapterError } from '../src/errors.ts';
import addnode from './fixtures/event-addnode.json' with { type: 'json' };
import nodesFixture from './fixtures/nodes.json' with { type: 'json' };
import { PC01_ID, scope } from './scope.ts';
import { FakeRequester } from './support/fake-requester.ts';

function setup() {
  const client = new FakeRequester();
  const devices = new MeshCentralDeviceManagement(client, new Map([['site-a', scope]]));
  return { client, devices };
}

describe('MeshCentralDeviceManagement', () => {
  test('listDevices maps nodes for the site scope', async () => {
    const { client, devices } = setup();
    client.replies.set('nodes', nodesFixture);
    const list = await devices.listDevices('site-a');
    expect(client.sent).toEqual([{ action: 'nodes', payload: {} }]);
    expect(list.map((d) => d.upstream.meshNodeId)).toEqual([PC01_ID]);
  });

  test('listDevices rejects an unknown site', async () => {
    const { devices } = setup();
    const err = await devices.listDevices('unknown').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('scope_denied');
  });

  test('binding from another domain is scope_denied', async () => {
    const { client, devices } = setup();
    client.replies.set('nodes', nodesFixture);
    const upstream = { ...scope, meshDomainId: 'other', meshNodeId: PC01_ID };
    const err = await devices.reconcileEnrollment({ siteId: 'site-a', deviceId: 'd1', upstream }).catch((e) => e);
    expect((err as AdapterError).code).toBe('scope_denied');
    const otherInstance = { ...scope, meshInstanceId: 'mc2', meshNodeId: PC01_ID };
    const err2 = await devices
      .reconcileEnrollment({ siteId: 'site-a', deviceId: 'd1', upstream: otherInstance })
      .catch((e) => e);
    expect((err2 as AdapterError).code).toBe('scope_denied');
    expect(client.sent).toEqual([]);
  });

  test('missing node is node_not_found', async () => {
    const { client, devices } = setup();
    client.replies.set('nodes', nodesFixture);
    const missing = { ...scope, meshNodeId: 'nope' };
    expect(await devices.reconcileEnrollment({ siteId: 'site-a', deviceId: 'd1', upstream: missing })).toEqual({
      status: 'node_not_found',
    });
    const found = await devices.reconcileEnrollment({
      siteId: 'site-a',
      deviceId: 'd1',
      upstream: { ...scope, meshNodeId: PC01_ID },
    });
    expect(found.status).toBe('bound');
    expect(found.status === 'bound' && found.snapshot.upstream.meshNodeId).toBe(PC01_ID);
  });

  test('subscribeDeviceEvents forwards mapped events and resync', () => {
    const { client, devices } = setup();
    const events: DeviceEvent[] = [];
    const unsubscribe = devices.subscribeDeviceEvents((e) => events.push(e));
    client.emit(addnode);
    client.emit({ action: 'event', event: { action: 'login' } });
    client.resync();
    expect(events.map((e) => e.type)).toEqual(['device.added', 'resync']);
    unsubscribe();
    client.emit(addnode);
    client.resync();
    expect(events).toHaveLength(2);
  });
  describe('requestPowerAction', () => {
    const upstream = { ...scope, meshNodeId: PC01_ID };
    const node = `node/${scope.meshDomainId}/${PC01_ID}`;

    test('power actions map to MeshCentral action types', async () => {
      const { client, devices } = setup();
      for (const type of ['shutdown', 'reboot', 'sleep'] as const) {
        expect(await devices.requestPowerAction({ siteId: 'site-a', upstream, type })).toEqual({ accepted: true });
      }
      expect(client.sent).toEqual([
        { action: 'poweraction', payload: { nodeids: [node], actiontype: 2 } },
        { action: 'poweraction', payload: { nodeids: [node], actiontype: 3 } },
        { action: 'poweraction', payload: { nodeids: [node], actiontype: 4 } },
      ]);
    });

    test('a power reply other than ok is an invalid upstream message', async () => {
      const { client, devices } = setup();
      client.replies.set('poweraction', { action: 'poweraction', result: 'nope' });
      const err = await devices.requestPowerAction({ siteId: 'site-a', upstream, type: 'reboot' }).catch((e) => e);
      expect((err as AdapterError).code).toBe('invalid_upstream_message');
    });

    test('wake results map to accepted, wake_unsupported and node_missing', async () => {
      const { client, devices } = setup();
      const cases: [string, unknown][] = [
        ['ok', { accepted: true }],
        ['Used 2 device(s) to send wake packets', { accepted: true }],
        ['Used 0 device(s) to send wake packets', { accepted: true }],
        ['No known MAC addresses for this device', { accepted: false, reason: 'wake_unsupported' }],
        ['No network information for this device', { accepted: false, reason: 'wake_unsupported' }],
        ['Invalid nodeid', { accepted: false, reason: 'node_missing' }],
        ['Invalid domain', { accepted: false, reason: 'node_missing' }],
      ];
      for (const [result, expected] of cases) {
        // Haqiqiy MeshControlClient 'ok' bo'lmagan result'ni upstream_rejected qiladi, matn detail'da.
        client.replies.set(
          'wakedevices',
          result === 'ok'
            ? { action: 'wakedevices', result }
            : new AdapterError('upstream_rejected', 'MeshCentral rejected wakedevices', result),
        );
        expect(await devices.requestPowerAction({ siteId: 'site-a', upstream, type: 'wake' }), result).toEqual(
          expected,
        );
      }
      expect(client.sent.at(-1)).toEqual({ action: 'wakedevices', payload: { nodeids: [node] } });
      client.replies.set('wakedevices', new AdapterError('upstream_rejected', 'rejected', 'something else'));
      const err = await devices.requestPowerAction({ siteId: 'site-a', upstream, type: 'wake' }).catch((e) => e);
      expect((err as AdapterError).code).toBe('invalid_upstream_message');
    });

    test('a node outside the site scope is refused before sending', async () => {
      const { client, devices } = setup();
      for (const bad of [
        { ...upstream, meshDomainId: 'other' },
        { ...upstream, meshInstanceId: 'mc2' },
      ]) {
        const err = await devices
          .requestPowerAction({ siteId: 'site-a', upstream: bad, type: 'shutdown' })
          .catch((e) => e);
        expect((err as AdapterError).code).toBe('scope_denied');
      }
      const err = await devices.requestPowerAction({ siteId: 'nope', upstream, type: 'shutdown' }).catch((e) => e);
      expect((err as AdapterError).code).toBe('scope_denied');
      expect(client.sent).toEqual([]);
    });
  });
});
