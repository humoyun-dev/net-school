import type { DevicePolicy, PolicyHint, PolicyReceipt } from '@netschool/contracts';
import { beforeEach, describe, expect, test } from 'vitest';
import { type CachedBaseline, PolicySync, type WebPolicyPush } from '../src/core/policy-sync.ts';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const HL = 'a'.repeat(64);
const LESSON = '7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a';

const baseline = (org: number, hash: string, blocked: string[] = ['bad.com']): DevicePolicy['baseline'] => ({
  revision: { org, site: 0 },
  hash,
  document: {
    web: { blocked },
    browser: { managed: false, incognito: 'allowed', devTools: 'allowed' },
    os: { standardUser: false, blockAppInstall: false, lockWallpaper: false },
  },
});
const lesson = (version = 1): NonNullable<DevicePolicy['lesson']> => ({
  lessonId: LESSON,
  version,
  hash: HL,
  document: { schemaVersion: 1, web: { mode: 'allowlist', patterns: ['docs.example.com'] } },
  leaseSeconds: 120,
});
const hint = (org: number, lessonVersion: number | null = null): PolicyHint => ({
  baseline: { org, site: 0 },
  lesson: lessonVersion === null ? null : { lessonId: LESSON, version: lessonVersion },
});

let now: number;
let served: DevicePolicy;
let fetches: number;
let receipts: PolicyReceipt[];
let pushes: WebPolicyPush[];
let stored: CachedBaseline | null;

function make() {
  return new PolicySync({
    fetch: async () => {
      fetches++;
      return served;
    },
    sendReceipt: async (r) => {
      receipts.push(r);
    },
    store: { load: () => stored, save: (b) => (stored = b) },
    clock: { nowMs: () => now },
    onChange: (p) => pushes.push(p),
  });
}

beforeEach(() => {
  now = 1_000;
  served = { baseline: baseline(1, H1), lesson: null };
  fetches = 0;
  receipts = [];
  pushes = [];
  stored = null;
});

describe('policy sync', () => {
  test('fetches on hint change only', async () => {
    const sync = make();
    await sync.onHint(hint(1));
    await sync.onHint(hint(1));
    expect(fetches).toBe(1);
    served = { baseline: baseline(2, H2), lesson: null };
    await sync.onHint(hint(2));
    expect(fetches).toBe(2);
    expect(sync.current().baseline?.hash).toBe(H2);
    expect(pushes.at(-1)?.baseline?.blocked).toEqual(['bad.com']);
  });

  test('missing hint (old hub) does nothing', async () => {
    const sync = make();
    await sync.onHint(undefined);
    expect(fetches).toBe(0);
  });

  test('baseline survives restart from cache', async () => {
    await make().onHint(hint(1));
    const restarted = make();
    expect(restarted.current().baseline).toMatchObject({ revision: { org: 1, site: 0 }, hash: H1 });
    expect(fetches).toBe(1);
    expect(restarted.current().lesson).toBeNull();
  });

  test('lesson layer expires on the monotonic lease', async () => {
    served = { baseline: baseline(1, H1), lesson: lesson() };
    const sync = make();
    await sync.onHint(hint(1, 1));
    expect(sync.current().lesson).toMatchObject({ lessonId: LESSON, version: 1, expiresInMs: 120_000 });
    now += 60_000;
    await sync.onHint(hint(1, 1)); // heartbeat lease'ni yangilaydi, qayta olinmaydi
    expect(fetches).toBe(1);
    now += 119_000;
    await sync.tick();
    expect(sync.current().lesson?.expiresInMs).toBe(1_000);
    now += 1_000;
    await sync.tick();
    expect(sync.current().lesson).toBeNull();
    expect(pushes.at(-1)?.lesson).toBeNull();
  });

  test('lesson ends when the hint drops it', async () => {
    served = { baseline: baseline(1, H1), lesson: lesson() };
    const sync = make();
    await sync.onHint(hint(1, 1));
    await sync.onHint(hint(1));
    expect(sync.current().lesson).toBeNull();
    expect(fetches).toBe(1);
  });

  test('receipt reflects extension confirmation', async () => {
    const sync = make();
    await sync.onHint(hint(1));
    await sync.tick();
    expect(receipts.at(-1)).toEqual({
      layer: 'baseline',
      revision: { org: 1, site: 0 },
      hash: H1,
      rules: { 'web.blocked': { state: 'failed', code: 'extension_missing' } },
    });
    // Eski hash bilan tasdiq: receipt yuborilmaydi (kutadi).
    sync.onExtensionReport({ browser: 'chrome', extensionVersion: '1.0.0', baselineHash: H2, lessonHash: null });
    const before = receipts.length;
    await sync.tick();
    expect(receipts.length).toBe(before);
    sync.onExtensionReport({ browser: 'chrome', extensionVersion: '1.0.0', baselineHash: H1, lessonHash: null });
    await sync.tick();
    expect(receipts.at(-1)?.rules).toEqual({ 'web.blocked': { state: 'applied' } });
    // O'zgarmagan receipt qayta yuborilmaydi, 60 s'dan keyin yangilanadi.
    const sent = receipts.length;
    await sync.tick();
    expect(receipts.length).toBe(sent);
    now += 30_000;
    sync.onExtensionReport({ browser: 'chrome', extensionVersion: '1.0.0', baselineHash: H1, lessonHash: null });
    now += 31_000;
    await sync.tick();
    expect(receipts.length).toBe(sent + 1);
  });

  test('lesson receipt is sent for the lesson layer', async () => {
    served = { baseline: baseline(1, H1), lesson: lesson() };
    const sync = make();
    await sync.onHint(hint(1, 1));
    sync.onExtensionReport({ browser: 'edge', extensionVersion: '1.0.0', baselineHash: H1, lessonHash: HL });
    await sync.tick();
    expect(receipts).toContainEqual({
      layer: 'lesson',
      lessonId: LESSON,
      version: 1,
      hash: HL,
      rules: { 'web.lesson': { state: 'applied' } },
    });
  });

  test('web.filter capability follows extension presence', async () => {
    const sync = make();
    expect(sync.webFilterState()).toBe('requires_setup');
    sync.onExtensionReport({ browser: 'chrome', extensionVersion: '1.0.0', baselineHash: null, lessonHash: null });
    expect(sync.webFilterState()).toBe('available');
    now += 60_001;
    expect(sync.webFilterState()).toBe('requires_setup');
  });

  test('fetch failure keeps the cached baseline and retries on next hint', async () => {
    const sync = make();
    await sync.onHint(hint(1));
    served = undefined as unknown as DevicePolicy;
    const broken = new PolicySync({
      fetch: async () => {
        throw new Error('offline');
      },
      sendReceipt: async () => {},
      store: { load: () => stored, save: () => {} },
      clock: { nowMs: () => now },
      onChange: () => {},
    });
    await expect(broken.onHint(hint(2))).rejects.toThrow('offline');
    expect(broken.current().baseline?.hash).toBe(H1);
  });

  test('lease renewal is pushed to the extension', async () => {
    served = { baseline: baseline(1, H1), lesson: lesson() };
    const sync = make();
    await sync.onHint(hint(1, 1));
    const before = pushes.length;
    now += 60_000;
    await sync.onHint(hint(1, 1));
    expect(pushes.length).toBe(before + 1);
    expect(pushes.at(-1)?.lesson?.expiresInMs).toBe(120_000);
  });

  test('every fresh browser must confirm the current hash', async () => {
    const sync = make();
    await sync.onHint(hint(1));
    sync.onExtensionReport({ browser: 'chrome', extensionVersion: '1.0.0', baselineHash: H1, lessonHash: null });
    sync.onExtensionReport({ browser: 'edge', extensionVersion: '1.0.0', baselineHash: H2, lessonHash: null });
    await sync.tick();
    expect(receipts.filter((r) => r.rules['web.blocked']?.state === 'applied')).toHaveLength(0);
    sync.onExtensionReport({ browser: 'edge', extensionVersion: '1.0.0', baselineHash: H1, lessonHash: null });
    await sync.tick();
    expect(receipts.at(-1)?.rules).toEqual({ 'web.blocked': { state: 'applied' } });
  });
});
