import { describe, expect, test } from 'vitest';
import { AdapterError } from '../src/errors.ts';
import { mapNodesResponse } from '../src/map-nodes.ts';
import nodesFixture from './fixtures/nodes.json' with { type: 'json' };
import { PC01_ID, scope } from './scope.ts';

const node = (extra: Record<string, unknown>) => ({
  action: 'nodes',
  nodes: { 'mesh//m1': [{ _id: 'node//n1', name: 'pc-02', ...extra }] },
});

describe('mapNodesResponse', () => {
  test('maps the captured offline local device', () => {
    expect(mapNodesResponse(nodesFixture, scope)).toEqual([
      {
        upstream: { meshInstanceId: 'mc1', meshDomainId: '', meshNodeId: PC01_ID },
        name: 'pc-01',
        hostname: 'pc-01.lan',
        osDescription: null,
        agentOnline: false,
        powerState: 'unknown',
      },
    ]);
  });

  test('maps an online, powered agent', () => {
    const [snap] = mapNodesResponse(node({ conn: 1, pwr: 1, osdesc: 'Windows 11' }), scope);
    expect(snap).toMatchObject({ agentOnline: true, powerState: 'on', osDescription: 'Windows 11', hostname: null });
  });

  test.each([
    [2, 'sleep'],
    [5, 'sleep'],
    [6, 'off'],
    [7, 'unknown'],
  ])('maps pwr %i to %s', (pwr, expected) => {
    expect(mapNodesResponse(node({ pwr }), scope)[0]?.powerState).toBe(expected);
  });

  test('treats conn without the agent bit as offline', () => {
    expect(mapNodesResponse(node({ conn: 4 }), scope)[0]?.agentOnline).toBe(false);
  });

  test('rejects a response without nodes', () => {
    expect(() => mapNodesResponse({ action: 'nodes' }, scope)).toThrow(AdapterError);
    try {
      mapNodesResponse({ action: 'nodes' }, scope);
    } catch (err) {
      expect((err as AdapterError).code).toBe('invalid_upstream_message');
    }
  });

  test('skips nodes from a foreign domain', () => {
    const msg = { action: 'nodes', nodes: { 'mesh/x/m': [{ _id: 'node/x/n', name: 'other' }] } };
    expect(mapNodesResponse(msg, scope)).toEqual([]);
  });
});
