import { describe, expect, test } from 'vitest';
import { parseDeviceEvent } from '../src/map-events.ts';
import addnode from './fixtures/event-addnode.json' with { type: 'json' };
import changenode from './fixtures/event-changenode.json' with { type: 'json' };
import removenode from './fixtures/event-removenode.json' with { type: 'json' };
import { PC01_ID, scope } from './scope.ts';

const pc01 = { meshInstanceId: 'mc1', meshDomainId: '', meshNodeId: PC01_ID };

describe('parseDeviceEvent', () => {
  test('maps captured node lifecycle events', () => {
    expect(parseDeviceEvent(addnode, scope)).toEqual({ type: 'device.added', upstream: pc01 });
    expect(parseDeviceEvent(changenode, scope)).toEqual({ type: 'device.changed', upstream: pc01 });
    expect(parseDeviceEvent(removenode, scope)).toEqual({ type: 'device.removed', upstream: pc01 });
  });

  test('maps nodeconnect to connectivity', () => {
    const msg = { action: 'event', event: { action: 'nodeconnect', nodeid: 'node//abc', conn: 1, pwr: 1 } };
    expect(parseDeviceEvent(msg, scope)).toEqual({
      type: 'device.connectivity',
      upstream: { meshInstanceId: 'mc1', meshDomainId: '', meshNodeId: 'abc' },
      agentOnline: true,
      powerState: 'on',
    });
  });

  test('parseDeviceEvent returns null for unknown actions and malformed payloads', () => {
    for (const msg of [
      { action: 'event', event: { action: 'login' } },
      {},
      null,
      'x',
      { action: 'event' },
      { action: 'event', event: { action: 'removenode' } },
      { action: 'event', event: { action: 'addnode', node: { name: 'no-id' } } },
      { action: 'event', event: { action: 'toString', nodeid: 'node//abc' } },
      { action: 'event', event: { action: 'constructor', nodeid: 'node//abc' } },
    ]) {
      expect(parseDeviceEvent(msg, scope)).toBeNull();
    }
  });

  test('ignores events for a foreign domain', () => {
    const msg = { action: 'event', event: { action: 'removenode', nodeid: 'node/other/abc' } };
    expect(parseDeviceEvent(msg, scope)).toBeNull();
  });
});
