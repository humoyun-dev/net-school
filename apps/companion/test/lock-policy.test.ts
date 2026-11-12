import { describe, expect, test } from 'vitest';
import { StateCache } from '../src/core/cache.ts';
import {
  DISABLE_TASK_MGR,
  LOCK_POLICY,
  LockPolicy,
  type RegistryEntry,
  type RegistryPort,
} from '../src/core/lock-policy.ts';

const id = (e: RegistryEntry) => `${e.key}|${e.name}`;

class FakeRegistry implements RegistryPort {
  readonly values = new Map<string, number>();
  async read(e: RegistryEntry) {
    return this.values.get(id(e)) ?? null;
  }
  async write(e: RegistryEntry, value: number) {
    this.values.set(id(e), value);
  }
  async remove(e: RegistryEntry) {
    this.values.delete(id(e));
  }
}

function setup() {
  const cache = StateCache.open(':memory:');
  const registry = new FakeRegistry();
  const store = {
    load: () => cache.loadPolicyJournal(),
    save: (j: Parameters<typeof cache.savePolicyJournal>[0]) => cache.savePolicyJournal(j),
  };
  return { cache, registry, policy: new LockPolicy(registry, store) };
}

describe('lock policy', () => {
  test('apply sets every value to 1 and journals the previous state', async () => {
    const { registry, policy, cache } = setup();
    registry.values.set(id(DISABLE_TASK_MGR), 0); // DisableTaskMgr oldin 0 edi
    await policy.apply();
    for (const e of LOCK_POLICY) expect(registry.values.get(id(e))).toBe(1);
    const journal = cache.loadPolicyJournal();
    expect(journal).toHaveLength(LOCK_POLICY.length);
    expect(journal?.find((j) => j.name === 'DisableTaskMgr')?.previous).toBe(0);
    expect(journal?.find((j) => j.name === 'DisableLockWorkstation')?.previous).toBeNull();
  });

  test('restore returns absent values to absent and existing ones to their old value', async () => {
    const { registry, policy, cache } = setup();
    registry.values.set(id(DISABLE_TASK_MGR), 0);
    await policy.apply();
    await policy.restore();
    expect(registry.values.get(id(DISABLE_TASK_MGR))).toBe(0);
    for (const e of LOCK_POLICY.slice(1)) expect(registry.values.has(id(e))).toBe(false);
    expect(cache.loadPolicyJournal()).toBeNull();
  });

  test('applying twice keeps the original previous values', async () => {
    const { registry, policy } = setup();
    await policy.apply();
    await policy.apply();
    await policy.restore();
    expect(registry.values.size).toBe(0);
  });

  test('a crash while locked is repaired by reconcile on the next start', async () => {
    const { registry, policy } = setup();
    await policy.apply();
    expect(policy.hasPendingRestore()).toBe(true);
    await policy.reconcile(true); // bloklash hali faol: tegilmaydi
    expect(registry.values.size).toBe(LOCK_POLICY.length);
    await policy.reconcile(false);
    expect(registry.values.size).toBe(0);
    expect(policy.hasPendingRestore()).toBe(false);
  });

  test('a failed restore keeps only the failed values in the journal and reports the error', async () => {
    const { registry, policy, cache } = setup();
    await policy.apply();
    // restore oldingi qiymati yo'q bo'lganlarni remove bilan qaytaradi, shuning uchun remove'ni buzamiz.
    const originalRemove = registry.remove.bind(registry);
    registry.remove = async (e) => {
      if (e.name === 'NoWinKeys') throw new Error('locked by another process');
      return originalRemove(e);
    };
    await expect(policy.restore()).rejects.toThrow(/could not restore 1/);
    expect(cache.loadPolicyJournal()?.map((j) => j.name)).toEqual(['NoWinKeys']);
    registry.remove = originalRemove;
    await policy.restore();
    expect(registry.values.size).toBe(0);
    expect(policy.hasPendingRestore()).toBe(false);
  });

  test('restore with no journal is a no-op', async () => {
    const { policy } = setup();
    await expect(policy.restore()).resolves.toBeUndefined();
  });

  test('journal survives reopening the cache file', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'ns-policy-')), 'state.sqlite');
    const first = StateCache.open(file);
    first.savePolicyJournal([{ key: 'K', name: 'N', previous: null }]);
    first.close();
    const second = StateCache.open(file);
    expect(second.loadPolicyJournal()).toEqual([{ key: 'K', name: 'N', previous: null }]);
    second.close();
  });
});
