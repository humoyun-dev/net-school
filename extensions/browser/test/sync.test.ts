import { beforeEach, describe, expect, test } from 'vitest';
import { type KV, PolicyState } from '../src/state.ts';
import { ExtensionSync } from '../src/sync.ts';

class MemKV implements KV {
  data: Record<string, unknown> = {};
  async get(k: string) {
    return this.data[k];
  }
  async set(k: string, v: unknown) {
    this.data[k] = v;
  }
  async remove(k: string) {
    delete this.data[k];
  }
}

const H = 'a'.repeat(64);
const L = 'b'.repeat(64);
const policy = (lesson: boolean) => ({
  type: 'policy' as const,
  baseline: { revision: { org: 1, site: 0 }, hash: H, blocked: ['bad.com'] },
  lesson: lesson
    ? {
        lessonId: 'l1',
        version: 1,
        hash: L,
        web: { mode: 'allowlist' as const, patterns: ['docs.com'] },
        expiresInMs: 120_000,
      }
    : null,
});

let now: number;
let posts: { lessonHash: string | null; baselineHash: string | null }[];
let rules: { id: number }[];
let failUpdates: number;
let sync: ExtensionSync;

beforeEach(() => {
  now = 1_000_000;
  posts = [];
  rules = [];
  failUpdates = 0;
  sync = new ExtensionSync({
    state: new PolicyState({ local: new MemKV(), session: new MemKV() }, () => now),
    dnr: {
      get: async () => rules,
      update: async (o) => {
        if (failUpdates-- > 0) throw new Error('dnr');
        rules = (o.addRules as { id: number }[]) ?? [];
      },
    },
    post: (m) => posts.push(m as never),
    browser: 'chrome',
    version: '0.1.0',
  });
});

describe('extension sync', () => {
  test('re-acknowledges the installed policy on every tick', async () => {
    await sync.onPolicy(policy(false));
    expect(posts).toHaveLength(1);
    await sync.tick();
    await sync.tick();
    expect(posts).toHaveLength(3);
    expect(posts.at(-1)).toMatchObject({ baselineHash: H, lessonHash: null });
  });

  test('a failed install sends nothing and is retried on the next tick', async () => {
    failUpdates = 2;
    await expect(sync.onPolicy(policy(false))).rejects.toThrow();
    expect(posts).toHaveLength(0);
    expect(sync.blocked('https://bad.com/')).toBe(true); // navigatsiya tekshiruvi baribir ishlaydi
    await sync.tick();
    expect(posts).toHaveLength(1);
    expect(rules.length).toBeGreaterThan(0);
  });

  test('a renewed lesson push keeps lesson rules past the first deadline', async () => {
    await sync.onPolicy(policy(true));
    now += 100_000;
    await sync.onPolicy(policy(true));
    now += 50_000;
    await sync.tick();
    expect(posts.at(-1)).toMatchObject({ lessonHash: L });
    expect(sync.blocked('https://other.com/')).toBe(true);
  });
});
