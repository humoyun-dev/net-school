import { describe, expect, test } from 'vitest';
import { TicketStore } from '../src/tickets.ts';

describe('TicketStore', () => {
  test('ticket is single use', () => {
    const store = new TicketStore();
    const { ticket } = store.issue('s1');
    expect(store.redeem(ticket)).toEqual({ sessionId: 's1' });
    expect(store.redeem(ticket)).toEqual({ error: 'unknown' });
  });

  test('ticket expires after 30 s', () => {
    let now = 1_000;
    const store = new TicketStore({ now: () => now });
    const { ticket, expiresAt } = store.issue('s1');
    expect(expiresAt).toBe(31_000);
    now += 30_001;
    expect(store.redeem(ticket)).toEqual({ error: 'expired' });
    // muddati o'tgan ticket ham sarflangan
    expect(store.redeem(ticket)).toEqual({ error: 'unknown' });
  });

  test('ticket is still valid exactly at the ttl boundary', () => {
    let now = 0;
    const store = new TicketStore({ now: () => now });
    const { ticket } = store.issue('s1');
    now = 30_000;
    expect(store.redeem(ticket)).toEqual({ sessionId: 's1' });
  });

  test('unknown ticket is rejected', () => {
    expect(new TicketStore().redeem('nope')).toEqual({ error: 'unknown' });
  });

  test('concurrent redeem yields exactly one binding', async () => {
    const store = new TicketStore();
    const { ticket } = store.issue('s1');
    const results = await Promise.all([
      Promise.resolve().then(() => store.redeem(ticket)),
      Promise.resolve().then(() => store.redeem(ticket)),
    ]);
    expect(results.filter((r) => 'sessionId' in r)).toHaveLength(1);
    expect(results.filter((r) => 'error' in r)).toEqual([{ error: 'unknown' }]);
  });

  test('store keeps only hashes', () => {
    const store = new TicketStore();
    let ticket = '';
    const maps = captureMaps(() => {
      ticket = store.issue('s1').ticket;
    });
    const dump = JSON.stringify(maps.flatMap((m) => [...m]));
    expect(maps.length).toBeGreaterThan(0);
    expect(dump).not.toContain(ticket);
    expect(dump).toContain('s1');
  });

  test('issued tickets are 43-char base64url and unique', () => {
    const store = new TicketStore();
    const tickets = Array.from({ length: 200 }, () => store.issue('s1').ticket);
    for (const t of tickets) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tickets).size).toBe(200);
  });

  test('expired entries are pruned on issue', () => {
    let now = 0;
    const store = new TicketStore({ now: () => now });
    const maps = captureMaps(() => {
      store.issue('a');
      now = 40_000;
      store.issue('b');
    });
    expect(maps[0]?.size).toBe(1);
  });
});

// Private xaritaga Map.prototype.set orqali kuzatamiz (ichki maydonga bog'liq bo'lmaslik uchun).
function captureMaps(run: () => void): Map<unknown, unknown>[] {
  const seen = new Set<Map<unknown, unknown>>();
  const original = Map.prototype.set;
  Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    seen.add(this);
    return original.call(this, key, value);
  } as typeof Map.prototype.set;
  try {
    run();
  } finally {
    Map.prototype.set = original;
  }
  return [...seen];
}
