import { describe, expect, test } from 'vitest';
import { RemoteSessionBroker } from '../src/broker.ts';
import { SessionRegistry } from '../src/registry.ts';
import { TicketStore } from '../src/tickets.ts';
import type { GatewayEvent } from '../src/types.ts';
import { FakeViewerUpstream } from './support/fake-upstream.ts';

const req = {
  sessionId: 'rs-1',
  actorId: 'teacher-1',
  device: { meshInstanceId: 'mc', meshDomainId: '', meshNodeId: 'node//abc' },
  mode: 'view' as const,
};

function setup() {
  const upstream = new FakeViewerUpstream();
  const tickets = new TicketStore();
  const registry = new SessionRegistry();
  const events: GatewayEvent[] = [];
  const broker = new RemoteSessionBroker({ upstream, tickets, registry, onEvent: (e) => events.push(e) });
  return { upstream, tickets, registry, events, broker };
}

describe('RemoteSessionBroker', () => {
  test('open creates upstream session then issues ticket', async () => {
    const { upstream, tickets, registry, broker } = setup();
    const out = await broker.open(req);
    expect(upstream.opened).toEqual([req]);
    expect(out.sessionId).toBe('rs-1');
    expect(registry.get('rs-1')?.upstream).toBe(upstream.sessions[0]);
    expect(tickets.redeem(out.ticket)).toEqual({ sessionId: 'rs-1' });
  });

  test('open does not issue a ticket when upstream open fails', async () => {
    const { upstream, registry, events, broker } = setup();
    upstream.openError = new Error('login refused');
    const issued: string[] = [];
    const tickets = new TicketStore();
    const spy = tickets.issue.bind(tickets);
    tickets.issue = (id) => {
      issued.push(id);
      return spy(id);
    };
    const b = new RemoteSessionBroker({ upstream, tickets, registry, onEvent: (e) => events.push(e) });
    await expect(b.open(req)).rejects.toThrow('login refused');
    expect(issued).toEqual([]);
    expect(registry.get('rs-1')).toBeUndefined();
    expect(events).toEqual([{ type: 'upstream_error', sessionId: 'rs-1', message: 'login refused' }]);
    void broker;
  });

  test('open revokes the upstream session when the id is already registered', async () => {
    const { upstream, broker } = setup();
    await broker.open(req);
    await expect(broker.open(req)).rejects.toThrow();
    expect(upstream.sessions[0]?.revokeCalls).toBe(0);
    expect(upstream.sessions[1]?.revokeCalls).toBe(1);
  });

  test('broker reports a failed orphan revoke', async () => {
    const { upstream, events, broker } = setup();
    await broker.open(req);
    upstream.nextRevokeError = new Error('deleteuser failed');
    await expect(broker.open(req)).rejects.toThrow('already registered');
    expect(events).toContainEqual({ type: 'upstream_error', sessionId: 'rs-1', message: 'deleteuser failed' });
    expect(upstream.sessions[1]?.revokeCalls).toBe(1);
  });

  test('close delegates to registry with reason revoked', async () => {
    const { upstream, registry, events, broker } = setup();
    await broker.open(req);
    const calls: Array<[string, string]> = [];
    const original = registry.close.bind(registry);
    registry.close = (id, reason) => {
      calls.push([id, reason]);
      return original(id, reason);
    };
    const session = registry.get('rs-1');
    await broker.close('rs-1');
    expect(calls).toEqual([['rs-1', 'revoked']]);
    expect(session?.closed).toBe(true);
    // Revoke qilingan sessiya registry'da qolmaydi; isOpen kabi tekshiruvlar uni yopiq deb ko'radi.
    expect(registry.get('rs-1')).toBeUndefined();
    expect(upstream.sessions[0]?.revokeCalls).toBe(1);
    expect(events).toEqual([{ type: 'session_closed', sessionId: 'rs-1', reason: 'revoked' }]);
  });

  test('close reports revoke failure but the session stays closed', async () => {
    const { upstream, registry, events, broker } = setup();
    await broker.open(req);
    const failure = new Error('deleteuser failed');
    const session = upstream.sessions[0];
    if (session) session.revokeError = failure;
    await expect(broker.close('rs-1')).rejects.toBe(failure);
    expect(registry.get('rs-1')?.closed).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['upstream_error', 'session_closed']);
  });
});
