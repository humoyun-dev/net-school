import type { RemoteSession } from '@netschool/contracts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  RemoteSessionController,
  type RenewTimer,
  type ViewerApi,
  ViewerApiError,
  type ViewerState,
} from '../src/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-02T10:00:00.000Z';
const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({
  id: id(1),
  lessonId: id(2),
  deviceId: id(3),
  actorUserId: id(4),
  mode: 'control',
  status: 'active',
  openedAt: AT,
  expiresAt: AT,
  closedAt: null,
  closeReason: null,
  lease: { fencing: '7', expiresAt: AT },
  ...over,
});

function fakeTimer() {
  let tick: (() => void) | null = null;
  const timer: RenewTimer & { fire(): Promise<void>; everyMs: number | null; running: boolean } = {
    everyMs: null,
    running: false,
    start(everyMs, fn) {
      this.everyMs = everyMs;
      this.running = true;
      tick = fn;
    },
    stop() {
      this.running = false;
      tick = null;
    },
    async fire() {
      tick?.();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
  return timer;
}

function fakeApi(over: Partial<ViewerApi> = {}) {
  const calls: string[] = [];
  const api: ViewerApi = {
    openSession: vi.fn(async (lessonId, deviceId, mode, key) => {
      calls.push(`open ${lessonId} ${deviceId} ${mode} ${key}`);
      return session({ mode });
    }),
    ticket: vi.fn(async (sessionId) => {
      calls.push(`ticket ${sessionId}`);
      return { url: 'https://hub:8444/rs/redeem?ticket=abc' };
    }),
    renew: vi.fn(async (sessionId, fencing) => {
      calls.push(`renew ${sessionId} ${fencing ?? '-'}`);
      return session();
    }),
    close: vi.fn(async (sessionId) => {
      calls.push(`close ${sessionId}`);
    }),
    ...over,
  };
  return { api, calls };
}

function track(c: RemoteSessionController) {
  const states: ViewerState[] = [];
  c.subscribe((s) => states.push(s));
  return states;
}

afterEach(() => vi.restoreAllMocks());

describe('remote session controller', () => {
  test('open requests a session then a ticket and exposes the url', async () => {
    const { api, calls } = fakeApi();
    const timer = fakeTimer();
    const c = new RemoteSessionController({ api, timer, idempotencyKey: () => 'key-12345678' });
    const states = track(c);
    await c.open(id(2), id(3), 'view');
    expect(calls).toEqual([`open ${id(2)} ${id(3)} view key-12345678`, `ticket ${id(1)}`]);
    expect(states.map((s) => s.kind)).toEqual(['opening', 'open']);
    expect(states.at(-1)).toMatchObject({ kind: 'open', url: 'https://hub:8444/rs/redeem?ticket=abc', mode: 'view' });
    expect(timer.everyMs).toBe(10_000);
  });

  test('control_busy closes with that reason', async () => {
    const { api } = fakeApi({
      openSession: async () => {
        throw new ViewerApiError(409, 'control_busy');
      },
    });
    const c = new RemoteSessionController({ api, timer: fakeTimer(), idempotencyKey: () => 'key-12345678' });
    const states = track(c);
    await c.open(id(2), id(3), 'control');
    expect(states.at(-1)).toEqual({ kind: 'closed', reason: 'control_busy', code: 'control_busy' });
  });

  test('renewal sends the fencing token every interval', async () => {
    const { api, calls } = fakeApi();
    const timer = fakeTimer();
    const c = new RemoteSessionController({ api, timer, idempotencyKey: () => 'key-12345678' });
    await c.open(id(2), id(3), 'control');
    await timer.fire();
    await timer.fire();
    expect(calls.filter((x) => x.startsWith('renew'))).toEqual([`renew ${id(1)} 7`, `renew ${id(1)} 7`]);
    const view = fakeApi();
    const t2 = fakeTimer();
    const c2 = new RemoteSessionController({ api: view.api, timer: t2, idempotencyKey: () => 'key-12345678' });
    await c2.open(id(2), id(3), 'view');
    await t2.fire();
    expect(view.calls.at(-1)).toBe(`renew ${id(1)} -`);
  });

  test('a failed renewal marks the session expired and stops the timer', async () => {
    const { api } = fakeApi({
      renew: async () => {
        throw new ViewerApiError(409, 'conflict');
      },
    });
    const timer = fakeTimer();
    const c = new RemoteSessionController({ api, timer, idempotencyKey: () => 'key-12345678' });
    const states = track(c);
    await c.open(id(2), id(3), 'control');
    await timer.fire();
    expect(states.at(-1)).toMatchObject({ kind: 'closed', reason: 'expired' });
    expect(timer.running).toBe(false);
  });

  test('a session closed by the hub reports why', async () => {
    const { api } = fakeApi({ renew: async () => session({ status: 'closed', closeReason: 'lesson_ended' }) });
    const timer = fakeTimer();
    const c = new RemoteSessionController({ api, timer, idempotencyKey: () => 'key-12345678' });
    const states = track(c);
    await c.open(id(2), id(3), 'view');
    await timer.fire();
    expect(states.at(-1)).toMatchObject({ kind: 'closed', reason: 'lesson_ended' });
  });

  test('a network error during renewal keeps the session for the next tick', async () => {
    let fail = true;
    const { api } = fakeApi({
      renew: async () => {
        if (fail) throw new TypeError('Failed to fetch');
        return session();
      },
    });
    const timer = fakeTimer();
    const c = new RemoteSessionController({ api, timer, idempotencyKey: () => 'key-12345678' });
    const states = track(c);
    await c.open(id(2), id(3), 'control');
    await timer.fire();
    expect(states.at(-1)?.kind).toBe('open');
    fail = false;
    await timer.fire();
    expect(timer.running).toBe(true);
  });

  test('renewal keeps running while the tab is hidden', async () => {
    // Controller faqat berilgan RenewTimer'dan foydalanadi (worker): asosiy oqim taymerlari fon tabida sekinlashadi.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { api, calls } = fakeApi();
    const timer = fakeTimer();
    const c = new RemoteSessionController({ api, timer, idempotencyKey: () => 'key-12345678' });
    await c.open(id(2), id(3), 'control');
    for (let i = 0; i < 6; i++) await timer.fire();
    expect(calls.filter((x) => x.startsWith('renew'))).toHaveLength(6);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  test('closing the panel deletes the session', async () => {
    const { api, calls } = fakeApi();
    const timer = fakeTimer();
    const c = new RemoteSessionController({ api, timer, idempotencyKey: () => 'key-12345678' });
    const states = track(c);
    await c.open(id(2), id(3), 'view');
    await c.close();
    expect(calls.at(-1)).toBe(`close ${id(1)}`);
    expect(timer.running).toBe(false);
    expect(states.at(-1)).toEqual({ kind: 'closed', reason: 'closed' });
  });
  test('closing while the session is still opening deletes it and never starts renewal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { api, calls } = fakeApi({
      openSession: async (lessonId, deviceId, mode) => {
        await gate;
        calls.push(`open ${lessonId} ${deviceId} ${mode}`);
        return session({ mode });
      },
    });
    const timer = fakeTimer();
    const c = new RemoteSessionController({ api, timer, idempotencyKey: () => 'key-12345678' });
    const states = track(c);
    const opening = c.open(id(2), id(3), 'control');
    await c.close();
    release();
    await opening;
    expect(timer.running).toBe(false);
    expect(calls).toContain(`close ${id(1)}`);
    expect(calls.some((x) => x.startsWith('ticket'))).toBe(false);
    expect(states.at(-1)).toEqual({ kind: 'closed', reason: 'closed' });
  });
});
