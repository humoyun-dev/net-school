import { describe, expect, test } from 'vitest';
import { StateCache } from '../src/core/cache.ts';
import { HardLock, type KeyboardHook } from '../src/core/hard-lock.ts';
import { LOCK_POLICY, LockPolicy, type RegistryEntry, type RegistryPort } from '../src/core/lock-policy.ts';

const id = (e: RegistryEntry) => `${e.key}|${e.name}`;

class FakeRegistry implements RegistryPort {
  readonly values = new Map<string, number>();
  failWrite = false;
  failRemove = false;
  async read(e: RegistryEntry) {
    return this.values.get(id(e)) ?? null;
  }
  async write(e: RegistryEntry, v: number) {
    if (this.failWrite) throw new Error('write failed');
    this.values.set(id(e), v);
  }
  async remove(e: RegistryEntry) {
    if (this.failRemove) throw new Error('remove failed');
    this.values.delete(id(e));
  }
}

// Haqiqiy hook o'z oqimida KeyPolicy bilan ishlaydi (main/win-keyboard-hook.ts); bu yerda faqat o'rnatilgan/yo'q.
class FakeHook implements KeyboardHook {
  installed = false;
  installs = 0;
  failInstall = false;
  lose: ((err: unknown) => void) | null = null;
  async install(onLost: (err: unknown) => void) {
    if (this.failInstall) throw new Error('hook failed');
    this.installs += 1;
    this.installed = true;
    this.lose = (err) => {
      this.installed = false;
      onLost(err);
    };
  }
  async uninstall() {
    this.installed = false;
    this.lose = null;
  }
}

function setup() {
  const cache = StateCache.open(':memory:');
  const registry = new FakeRegistry();
  const hook = new FakeHook();
  const policy = new LockPolicy(registry, {
    load: () => cache.loadPolicyJournal(),
    save: (j) => cache.savePolicyJournal(j),
  });
  const errors: string[] = [];
  const lock = new HardLock({ policy, hook, onError: (reason) => errors.push(reason) });
  return { registry, hook, lock, errors, policy };
}

describe('hard lock', () => {
  test('locking installs the hook and the policy, unlocking removes both', async () => {
    const { registry, hook, lock } = setup();
    await lock.set(true);
    expect(hook.installed).toBe(true);
    expect(registry.values.size).toBe(LOCK_POLICY.length);
    expect(lock.facts()).toEqual({ enforced: true });

    await lock.set(false);
    expect(hook.installed).toBe(false);
    expect(registry.values.size).toBe(0);
  });

  test('locking twice installs the hook once', async () => {
    const { hook, lock } = setup();
    await lock.set(true);
    await lock.set(true);
    expect(hook.installs).toBe(1);
  });

  test('a hook failure keeps the policy but reports the lock as not enforced', async () => {
    const { registry, hook, lock, errors } = setup();
    hook.failInstall = true;
    await lock.set(true);
    expect(registry.values.size).toBe(LOCK_POLICY.length);
    expect(lock.facts()).toEqual({ enforced: false, reason: 'hook_failed' });
    expect(errors).toEqual(['hook_failed']);
    await lock.set(false);
    expect(registry.values.size).toBe(0);
    expect(lock.facts()).toEqual({ enforced: true });
  });

  test('a policy failure keeps the hook but reports the lock as not enforced', async () => {
    const { registry, hook, lock } = setup();
    registry.failWrite = true;
    await lock.set(true);
    expect(hook.installed).toBe(true);
    expect(lock.facts()).toEqual({ enforced: false, reason: 'policy_failed' });
  });

  // Windows sekin hook'ni olib tashlaydi yoki hook oqimi o'ladi: panel buni "kuchli" deb ko'rmasligi kerak.
  test('a hook lost while locked is reported, and the next lock installs it again', async () => {
    const { hook, lock, errors } = setup();
    await lock.set(true);
    hook.lose?.(new Error('thread exited'));
    expect(lock.facts()).toEqual({ enforced: false, reason: 'hook_failed' });
    expect(errors).toEqual(['hook_failed']);
    await lock.set(false);
    await lock.set(true);
    expect(hook.installed).toBe(true);
    expect(hook.installs).toBe(2);
    expect(lock.facts()).toEqual({ enforced: true });
  });

  // Hook oqimi o'lsa, bloklash keyingi lock'gacha ochiq qolmasin: davriy tekshiruv uni qayta o'rnatadi.
  test('the periodic reconcile reinstalls a hook lost while still locked', async () => {
    const { hook, lock } = setup();
    await lock.set(true);
    hook.lose?.(new Error('thread exited'));
    await lock.reconcile();
    expect(hook.installed).toBe(true);
    expect(hook.installs).toBe(2);
    expect(lock.facts()).toEqual({ enforced: true });
  });

  test('a failed restore is reported and retried until it succeeds', async () => {
    const { registry, lock, policy } = setup();
    await lock.set(true);
    registry.failRemove = true;
    await lock.set(false);
    expect(lock.facts()).toEqual({ enforced: false, reason: 'policy_restore_failed' });
    expect(policy.hasPendingRestore()).toBe(true);
    registry.failRemove = false;
    await lock.reconcile();
    expect(lock.facts()).toEqual({ enforced: true });
    expect(registry.values.size).toBe(0);
  });

  // main.ts har 30 s reconcile chaqiradi. Faol bloklash paytida jurnal har doim to'la: bu "qolib ketgan" siyosat emas.
  test('the periodic restore retry leaves an active lock in place', async () => {
    const { registry, hook, lock } = setup();
    await lock.set(true);
    await lock.reconcile();
    expect(hook.installed).toBe(true);
    expect(registry.values.size).toBe(LOCK_POLICY.length);
    expect(lock.facts()).toEqual({ enforced: true });
  });

  test('start repairs policy left behind by a crashed run', async () => {
    const { registry, lock, policy } = setup();
    await policy.apply(); // oldingi jarayon bloklab o'lgan
    await lock.start();
    expect(registry.values.size).toBe(0);
  });

  test('overlapping set calls run in order', async () => {
    const { registry, hook, lock } = setup();
    const a = lock.set(true);
    const b = lock.set(false);
    const c = lock.set(true);
    await Promise.all([a, b, c]);
    expect(hook.installed).toBe(true);
    expect(registry.values.size).toBe(LOCK_POLICY.length);
  });
});
