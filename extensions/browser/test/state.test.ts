import { beforeEach, describe, expect, test } from 'vitest';
import { type KV, PolicyState } from '../src/state.ts';

class MemKV implements KV {
  data: Record<string, unknown> = {};
  async get(key: string) {
    return this.data[key];
  }
  async set(key: string, value: unknown) {
    this.data[key] = value;
  }
  async remove(key: string) {
    delete this.data[key];
  }
}

const H = 'a'.repeat(64);
const msg = (lesson: boolean, expiresInMs = 120_000) => ({
  type: 'policy' as const,
  baseline: { revision: { org: 1, site: 0 }, hash: H, blocked: ['bad.com'] },
  lesson: lesson
    ? {
        lessonId: 'l1',
        version: 1,
        hash: 'b'.repeat(64),
        web: { mode: 'allowlist' as const, patterns: ['docs.com'] },
        expiresInMs,
      }
    : null,
});

let now: number;
let local: MemKV;
let session: MemKV;
const make = () => new PolicyState({ local, session }, () => now);

beforeEach(() => {
  now = 1_000_000;
  local = new MemKV();
  session = new MemKV();
});

describe('policy state', () => {
  test('effective web merges baseline and lesson', async () => {
    const s = make();
    const eff = await s.onPolicy(msg(true));
    expect(eff.web).toEqual({ block: ['bad.com'], allowOnly: ['docs.com'] });
    expect(eff.lessonHash).toBe('b'.repeat(64));
    expect(eff.baselineHash).toBe(H);
  });

  test('lesson rules expire without a fresh push', async () => {
    const s = make();
    await s.onPolicy(msg(true, 120_000));
    now += 119_999;
    expect((await s.effective()).web.allowOnly).toEqual(['docs.com']);
    now += 1;
    expect((await s.effective()).web.allowOnly).toBeNull();
  });

  test('browser restart drops lesson rules and keeps the baseline', async () => {
    await make().onPolicy(msg(true));
    session = new MemKV(); // storage.session brauzer qayta ochilganda bo'sh
    const eff = await make().effective();
    expect(eff.web).toEqual({ block: ['bad.com'], allowOnly: null });
    expect(eff.lessonHash).toBeNull();
  });

  test('clock moved back drops lesson rules', async () => {
    const s = make();
    await s.onPolicy(msg(true));
    now -= 1;
    expect((await s.effective()).web.allowOnly).toBeNull();
  });

  test('null baseline in a push keeps the stored baseline', async () => {
    const s = make();
    await s.onPolicy(msg(false));
    const eff = await s.onPolicy({ type: 'policy', baseline: null, lesson: null });
    expect(eff.web.block).toEqual(['bad.com']);
  });
});
