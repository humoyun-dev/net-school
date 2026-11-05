import { describe, expect, test } from 'vitest';
import { StateCache } from '../src/core/cache.ts';
import { HardLock, type KeyboardHook } from '../src/core/hard-lock.ts';
import { type KeyEvent, type KeyVerdict, VK } from '../src/core/key-policy.ts';
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

class FakeHook implements KeyboardHook {
  handler: ((e: KeyEvent) => KeyVerdict) | null = null;
  installs = 0;
  failInstall = false;
  install(handler: (e: KeyEvent) => KeyVerdict) {
    if (this.failInstall) throw new Error('hook failed');
    this.installs += 1;
    this.handler = handler;
  }
  uninstall() {
    this.handler = null;
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
    expect(hook.handler).not.toBeNull();
    expect(registry.values.size).toBe(LOCK_POLICY.length);
    expect(lock.facts()).toEqual({ enforced: true });
    expect(hook.handler?.({ vkCode: VK.LWIN, flags: 0, kind: 'down' })).toBe('block');

    await lock.set(false);
    expect(hook.handler).toBeNull();
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
    expect(hook.handler).not.toBeNull();
    expect(lock.facts()).toEqual({ enforced: false, reason: 'policy_failed' });
  });

  test('a failed restore is reported and retried until it succeeds', async () => {
    const { registry, lock, policy } = setup();
    await lock.set(true);
    registry.failRemove = true;
    await lock.set(false);
    expect(lock.facts()).toEqual({ enforced: false, reason: 'policy_restore_failed' });
    expect(policy.hasPendingRestore()).toBe(true);
    registry.failRemove = false;
    await lock.retryRestore();
    expect(lock.facts()).toEqual({ enforced: true });
    expect(registry.values.size).toBe(0);
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
    expect(hook.handler).not.toBeNull();
    expect(registry.values.size).toBe(LOCK_POLICY.length);
  });

  test('held modifiers do not leak from one lock to the next', async () => {
    const { hook, lock } = setup();
    await lock.set(true);
    hook.handler?.({ vkCode: 0xa4, flags: 0, kind: 'down' }); // Alt bosildi, up hech qachon kelmadi
    await lock.set(false);
    await lock.set(true);
    expect(hook.handler?.({ vkCode: VK.TAB, flags: 0, kind: 'down' })).toBe('pass');
  });
});
