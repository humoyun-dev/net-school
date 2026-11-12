import { createPrivateKey } from 'node:crypto';
import { makeCert } from '@netschool/test-support';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { startTestApp, type TestApp } from '../../api/test/support/app.ts';
import { seedDevice } from '../../api/test/support/device.ts';
import { issueCommand, startLesson } from '../../api/test/support/lesson.ts';
import { loginAs } from '../../api/test/support/login.ts';
import { seedOrg, seedRoom, seedUser } from '../../api/test/support/seed.ts';
import { type AgentStatus, CompanionAgent } from '../src/core/agent.ts';
import { StateCache } from '../src/core/cache.ts';
import type { PlatformFacts } from '../src/core/capabilities.ts';
import { type ClockSources, createClock } from '../src/core/clock.ts';
import { CommandProcessor } from '../src/core/commands.ts';
import { HubClient } from '../src/core/hub-client.ts';
import { type DeviceIdentity, generateDeviceKey, RequestSigner } from '../src/core/identity.ts';
import { OverlayController } from '../src/core/overlay.ts';
import { hubPolicyDeps, PolicySync } from '../src/core/policy-sync.ts';
import type { ThumbnailUploader } from '../src/core/thumbnails.ts';

// Har test to'liq hub (ilova, DB, TLS) ishga tushiradi: to'liq suite yukida 5 s yetmaydi.
vi.setConfig({ testTimeout: 30_000 });

const WINDOWS: PlatformFacts = { platform: 'win32', arch: 'x64', sessionType: null, screenAccess: 'unknown' };
const FAST = {
  heartbeatMs: 40,
  pollWaitSeconds: 1,
  capabilityCheckMs: 40,
  overlayTickMs: 20,
  backoffMinMs: 20,
  backoffMaxMs: 80,
  rejectedProbeMs: 10_000,
};

async function eventually<T>(
  check: () => T | null | false | undefined | Promise<T | null | false | undefined>,
  ms = 8_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface World {
  app: TestApp;
  admin: string;
  orgId: string;
  siteId: string;
  // Agentlarga tegmasdan hub'ni yopadi (hub o'chgan holatni sinash uchun).
  closeHub(): Promise<void>;
  close(): Promise<void>;
}

async function world(): Promise<World> {
  const app = await startTestApp();
  const { orgId, siteId } = await seedOrg(app.db.db);
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  const admin = await loginAs(app, 'admin1');
  // Hub faol ulanishlar tugaguncha yopilmaydi: oddiy yopishdan oldin agentlar to'xtatiladi.
  let closing: Promise<void> | null = null;
  const closeHub = () => {
    closing ??= app.close();
    return closing;
  };
  return {
    app,
    admin,
    orgId,
    siteId,
    closeHub,
    close: async () => {
      for (const r of running.splice(0)) await r.stop();
      await closeHub();
    },
  };
}

let roomCounter = 0;

// Yangi xona, unda qurilma va faol dars (admin ochgan).
async function lessonWithDevice(w: World) {
  const roomId = await seedRoom(w.app.db.db, w.orgId, w.siteId, `room-${++roomCounter}`);
  const key = generateDeviceKey();
  const deviceId = await seedDevice(w.app.db.db, w.orgId, w.siteId, key.publicKey, { roomId });
  const identity: DeviceIdentity = {
    deviceId,
    publicKey: key.publicKey,
    privateKey: createPrivateKey(key.privateKeyPem),
  };
  const lesson = (await startLesson(w.app, w.admin, roomId)).json;
  return { roomId, identity, lessonId: lesson.id as string };
}

interface Run {
  agent: CompanionAgent;
  hub: HubClient;
  overlay: OverlayController;
  cache: StateCache;
  statuses: AgentStatus[];
  messages: string[];
  last(): AgentStatus;
  stop(): Promise<void>;
}

const running: Run[] = [];

function makeAgent(
  origin: string,
  ca: string | null,
  identity: DeviceIdentity,
  over: {
    cache?: StateCache;
    sources?: ClockSources;
    facts?: () => Promise<PlatformFacts>;
    thumbnails?: ThumbnailUploader | null;
    policy?: (hub: HubClient, cache: StateCache) => PolicySync;
  } = {},
): Run {
  const signer = new RequestSigner(identity);
  const hub = new HubClient({ origin, ca, signer });
  const cache = over.cache ?? StateCache.open(':memory:');
  const clock = createClock(over.sources);
  const statuses: AgentStatus[] = [];
  const messages: string[] = [];
  const overlay = new OverlayController(clock, cache, () => {});
  const commands = new CommandProcessor({
    hub,
    cache,
    overlay,
    ui: { showMessage: (t: string) => messages.push(t) },
    retryDelayMs: 5,
  });
  const agent = new CompanionAgent(
    {
      hub,
      cache,
      overlay,
      commands,
      thumbnails: over.thumbnails ?? null,
      facts: over.facts ?? (async () => WINDOWS),
      onStatus: (s) => statuses.push(s),
      ...(over.policy ? { policy: over.policy(hub, cache) } : {}),
    },
    FAST,
  );
  const run: Run = {
    agent,
    hub,
    overlay,
    cache,
    statuses,
    messages,
    last: () => {
      const s = statuses.at(-1);
      if (!s) throw new Error('no status yet');
      return s;
    },
    stop: async () => {
      await agent.stop();
      hub.close();
    },
  };
  running.push(run);
  return run;
}

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  vi.restoreAllMocks();
});

const commandOf = async (w: World, id: string) =>
  (await w.app.request('GET', `/api/v1/commands/${id}`, { cookie: w.admin })).json;

describe('companion agent', () => {
  test('a teacher lock shows the overlay and the target succeeds', async () => {
    const w = await world();
    try {
      const { identity, lessonId } = await lessonWithDevice(w);
      const run = makeAgent(w.app.origin, w.app.ca, identity);
      await run.agent.start();
      await eventually(() => run.last().hub === 'online' && run.last().lessonId === lessonId);
      // Hub qurilmani capability bo'yicha ham tekshiradi: hisobot yetib kelishini kutamiz.
      await eventually(async () => {
        const list = await w.app.request('GET', `/api/v1/sites/${w.siteId}/devices`, { cookie: w.admin });
        return JSON.stringify(list.json).includes('classroom.overlay');
      });

      const issued = await issueCommand(w.app, w.admin, lessonId, {
        type: 'overlay.lock',
        payload: { message: 'Diqqat' },
      });
      expect(issued.status).toBe(202);
      await eventually(() => run.last().overlay.locked && run.last().overlay.message === 'Diqqat');
      const status = await eventually(async () => {
        const c = await commandOf(w, issued.json.id);
        return c.targets[0].status === 'succeeded' ? c : null;
      });
      expect(status.summary.succeeded).toBe(1);

      const unlock = await issueCommand(w.app, w.admin, lessonId, { type: 'overlay.unlock', payload: {} });
      await eventually(() => !run.last().overlay.locked);
      await eventually(async () => (await commandOf(w, unlock.json.id)).targets[0].status === 'succeeded');
    } finally {
      await w.close();
    }
  });

  test('an unlock issued while the device was offline applies from the first heartbeat', async () => {
    const w = await world();
    try {
      const { identity, lessonId } = await lessonWithDevice(w);
      const cache = StateCache.open(':memory:');
      const t = { perfMs: 0, uptimeMs: 5_000_000, wallMs: 1_800_000_000_000 };
      const sources: ClockSources = {
        perfNowMs: () => t.perfMs,
        uptimeSeconds: () => t.uptimeMs / 1000,
        wallMs: () => t.wallMs,
      };

      const first = makeAgent(w.app.origin, w.app.ca, identity, { cache, sources });
      await first.agent.start();
      await eventually(async () =>
        JSON.stringify(
          (await w.app.request('GET', `/api/v1/sites/${w.siteId}/devices`, { cookie: w.admin })).json,
        ).includes('classroom.overlay'),
      );
      await eventually(() => first.last().hub === 'online');
      await issueCommand(w.app, w.admin, lessonId, { type: 'overlay.lock', payload: {} });
      await eventually(() => first.last().overlay.locked);
      await first.stop(); // qurilma o'chdi, lock keshda qoldi

      await issueCommand(w.app, w.admin, lessonId, { type: 'overlay.unlock', payload: {} });

      // Shu boot ichida qayta ishga tushdi: lock keshdan tiklanadi, birinchi heartbeat uni olib tashlaydi.
      t.perfMs = 0;
      const second = makeAgent(w.app.origin, w.app.ca, identity, { cache, sources });
      await second.agent.start();
      expect(second.last().overlay.locked).toBe(true);
      await eventually(() => second.last().hub === 'online' && !second.last().overlay.locked);
      // Hub 'online' deb ko'rsatgan paytda eskirgan lock ko'rinmaydi.
      expect(second.statuses.some((s) => s.hub === 'online' && s.overlay.locked)).toBe(false);
    } finally {
      await w.close();
    }
  });

  test('the overlay falls when the hub stops answering', async () => {
    const w = await world();
    try {
      const { identity, lessonId } = await lessonWithDevice(w);
      const t = { perfMs: 0, uptimeMs: 5_000_000, wallMs: 1_800_000_000_000 };
      const sources: ClockSources = {
        perfNowMs: () => t.perfMs,
        uptimeSeconds: () => t.uptimeMs / 1000,
        wallMs: () => t.wallMs,
      };
      const run = makeAgent(w.app.origin, w.app.ca, identity, { sources });
      await run.agent.start();
      await eventually(async () =>
        JSON.stringify(
          (await w.app.request('GET', `/api/v1/sites/${w.siteId}/devices`, { cookie: w.admin })).json,
        ).includes('classroom.overlay'),
      );
      await eventually(() => run.last().hub === 'online');
      await issueCommand(w.app, w.admin, lessonId, { type: 'overlay.lock', payload: {} });
      await eventually(() => run.last().overlay.locked);

      void w.closeHub(); // hub o'chdi; agent ishlashda davom etadi
      const offline = await eventually(() => (run.last().hub === 'offline' ? run.last() : null));
      expect(offline.lastSeenAt).not.toBeNull();
      expect(run.last().overlay.locked).toBe(true); // lease tugaguncha ushlab turadi

      t.perfMs += 120_001;
      t.uptimeMs += 120_001;
      await eventually(() => !run.last().overlay.locked);
      expect(run.last().hub).toBe('offline');
    } finally {
      await w.close();
    }
  });

  test('a TLS failure shows tls_error and keeps retrying', async () => {
    const w = await world();
    try {
      const { identity } = await lessonWithDevice(w);
      const other = await makeCert('localhost');
      const run = makeAgent(w.app.origin, other.cert, identity);
      const spy = vi.spyOn(run.hub, 'json');
      await run.agent.start();
      await eventually(() => run.last().hub === 'tls_error');
      const heartbeats = () => spy.mock.calls.filter((c) => c[1] === '/api/v1/device/heartbeat').length;
      const before = heartbeats();
      await eventually(() => heartbeats() >= before + 3);
      expect(run.last().hub).toBe('tls_error');
    } finally {
      await w.close();
    }
  });

  test('help raised on the device shows in the room snapshot and a teacher clear resets it', async () => {
    const w = await world();
    try {
      const { identity, roomId, lessonId } = await lessonWithDevice(w);
      const run = makeAgent(w.app.origin, w.app.ca, identity);
      await run.agent.start();
      await eventually(() => run.last().hub === 'online' && run.last().lessonId === lessonId);

      await run.agent.raiseHelp();
      expect(run.last().help).not.toBeNull();
      const snapshot = (await w.app.request('GET', `/api/v1/events?roomId=${roomId}`, { cookie: w.admin })).json;
      expect(snapshot.snapshot.helpRequests).toHaveLength(1);
      expect(snapshot.snapshot.helpRequests[0].deviceId).toBe(identity.deviceId);

      const helpId = snapshot.snapshot.helpRequests[0].id;
      expect((await w.app.request('DELETE', `/api/v1/help-requests/${helpId}`, { cookie: w.admin })).status).toBe(204);
      await eventually(() => run.last().help === null);

      // O'quvchi o'zi qaytarib olishi ham mumkin.
      await run.agent.raiseHelp();
      await run.agent.withdrawHelp();
      expect(run.last().help).toBeNull();
      const again = (await w.app.request('GET', `/api/v1/events?roomId=${roomId}`, { cookie: w.admin })).json;
      expect(again.snapshot.helpRequests).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  test('capabilities are sent at start and again only when they change', async () => {
    const w = await world();
    try {
      const { identity } = await lessonWithDevice(w);
      let facts: PlatformFacts = { ...WINDOWS, platform: 'darwin', screenAccess: 'denied' };
      const run = makeAgent(w.app.origin, w.app.ca, identity, { facts: async () => facts });
      const spy = vi.spyOn(run.hub, 'json');
      const puts = () => spy.mock.calls.filter((c) => c[0] === 'PUT' && c[1] === '/api/v1/device/capabilities').length;
      await run.agent.start();
      await eventually(() => puts() === 1);
      await new Promise((r) => setTimeout(r, 300)); // bir nechta tekshiruv sikli
      expect(puts()).toBe(1);
      expect(run.last().thumbnails).toBe('requires_permission');

      facts = { ...facts, screenAccess: 'granted' }; // o'quvchi ruxsat berdi
      await eventually(() => puts() === 2);
      await new Promise((r) => setTimeout(r, 200));
      expect(puts()).toBe(2);
      await eventually(() => run.last().thumbnails === 'on'); // ruxsat bor va qurilma darsda
      const list = await w.app.request('GET', `/api/v1/sites/${w.siteId}/devices`, { cookie: w.admin });
      expect(JSON.stringify(list.json)).toContain('"classroom.thumbnails":{"state":"available"}');
    } finally {
      await w.close();
    }
  });

  test('thumbnails start with the lesson directive and stop when the lesson ends', async () => {
    const w = await world();
    try {
      const { identity, lessonId } = await lessonWithDevice(w);
      const uploader = { start: vi.fn(), stop: vi.fn() };
      const run = makeAgent(w.app.origin, w.app.ca, identity, { thumbnails: uploader as unknown as ThumbnailUploader });
      await run.agent.start();
      await eventually(() => uploader.start.mock.calls.length > 0);
      expect(uploader.start).toHaveBeenCalledWith({ intervalMs: 1_000, maxWidth: 480 });
      expect(run.last().thumbnails).toBe('on');

      const end = await w.app.request('POST', `/api/v1/lessons/${lessonId}/end`, {
        cookie: w.admin,
        headers: { 'idempotency-key': `end-${lessonId}` },
      });
      expect(end.status).toBe(200);
      await eventually(() => run.last().thumbnails === 'off' && run.last().lessonId === null);
      expect(uploader.stop).toHaveBeenCalled();
    } finally {
      await w.close();
    }
  });

  test('no thumbnails are started while the screen permission is missing', async () => {
    const w = await world();
    try {
      const { identity } = await lessonWithDevice(w);
      const uploader = { start: vi.fn(), stop: vi.fn() };
      const run = makeAgent(w.app.origin, w.app.ca, identity, {
        thumbnails: uploader as unknown as ThumbnailUploader,
        facts: async () => ({ ...WINDOWS, platform: 'darwin', screenAccess: 'denied' }),
      });
      await run.agent.start();
      await eventually(() => run.last().hub === 'online' && run.last().thumbnails === 'requires_permission');
      await new Promise((r) => setTimeout(r, 200));
      expect(uploader.start).not.toHaveBeenCalled();
    } finally {
      await w.close();
    }
  });

  test('a retired device reports rejected and stops polling', async () => {
    const w = await world();
    try {
      const { identity } = await lessonWithDevice(w);
      const run = makeAgent(w.app.origin, w.app.ca, identity);
      const spy = vi.spyOn(run.hub, 'json');
      await run.agent.start();
      await eventually(() => run.last().hub === 'online');

      expect((await w.app.request('DELETE', `/api/v1/devices/${identity.deviceId}`, { cookie: w.admin })).status).toBe(
        204,
      );
      await eventually(() => run.last().hub === 'rejected');
      const polls = () => spy.mock.calls.filter((c) => String(c[1]).startsWith('/api/v1/device/commands')).length;
      // Joriy long-poll (1 s) tugashi uchun kutiladi, so'ng yana bir long-poll davomida yangi so'rov bo'lmasligi kerak.
      await new Promise((r) => setTimeout(r, 1_300));
      const settled = polls();
      await new Promise((r) => setTimeout(r, 1_400));
      expect(polls()).toBe(settled);
      expect(run.last().hub).toBe('rejected');
    } finally {
      await w.close();
    }
  });

  test('stop does not wait for hub requests that never answer', async () => {
    const cert = await makeCert('localhost');
    const { createServer } = await import('node:https');
    const silent = createServer({ key: cert.key, cert: cert.cert }, () => {}); // so'rovga javob bermaydi
    await new Promise<void>((r) => silent.listen(0, 'localhost', r));
    const port = (silent.address() as { port: number }).port;
    try {
      const { identity } = await (async () => {
        const key = generateDeviceKey();
        return {
          identity: {
            deviceId: '7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a',
            publicKey: key.publicKey,
            privateKey: createPrivateKey(key.privateKeyPem),
          },
        };
      })();
      const run = makeAgent(`https://localhost:${port}`, cert.cert, identity);
      await run.agent.start();
      await new Promise((r) => setTimeout(r, 300)); // heartbeat va capability so'rovlari osilib turibdi
      const started = Date.now();
      await run.agent.stop();
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      silent.closeAllConnections();
      await new Promise((r) => silent.close(r));
    }
  });

  test('stop ends every loop', async () => {
    const w = await world();
    try {
      const { identity } = await lessonWithDevice(w);
      const run = makeAgent(w.app.origin, w.app.ca, identity);
      const spy = vi.spyOn(run.hub, 'json');
      await run.agent.start();
      await eventually(() => run.last().hub === 'online');
      await run.agent.stop();
      const calls = spy.mock.calls.length;
      await new Promise((r) => setTimeout(r, 400));
      expect(spy.mock.calls.length).toBe(calls);
    } finally {
      await w.close();
    }
  });

  test('heartbeat policy hint fetches the baseline and reports a receipt', async () => {
    const w = await world();
    try {
      const { identity } = await lessonWithDevice(w);
      const put = await w.app.request('PUT', `/api/v1/policies/baseline?siteId=${w.siteId}`, {
        body: { schemaVersion: 1, web: { blocked: ['bad.com'] } },
        cookie: w.admin,
        headers: { 'if-match': '0' },
      });
      expect(put.status).toBe(201);
      let sync: PolicySync | null = null;
      const run = makeAgent(w.app.origin, w.app.ca, identity, {
        policy: (hub, cache) => {
          sync = new PolicySync(hubPolicyDeps(hub, cache, createClock(), () => {}));
          return sync;
        },
      });
      await run.agent.start();
      await eventually(() => (sync?.current().baseline?.blocked ?? []).includes('bad.com'));
      expect(run.cache.loadBaseline()?.revision).toEqual({ org: 0, site: 1 });
      const status = async () =>
        (await w.app.request('GET', `/api/v1/policies/status?siteId=${w.siteId}`, { cookie: w.admin })).json.devices[0];
      await eventually(async () => (await status())?.baseline.companion !== null);
      expect((await status()).baseline.companion.rules).toEqual({
        'web.blocked': { state: 'failed', code: 'extension_missing' },
      });
    } finally {
      await w.close();
    }
  });
});
