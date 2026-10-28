// In-process long-poll uyg'otgichi: kalit (qurilma yoki xona) bo'yicha kutuvchilar. Bitta API jarayoni uchun.
export class Notifier {
  readonly #waiters = new Map<string, Set<() => void>>();

  wait(key: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const set = this.#waiters.get(key) ?? new Set<() => void>();
      this.#waiters.set(key, set);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0 && this.#waiters.get(key) === set) this.#waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done);
      set.add(done);
    });
  }

  wake(keys: Iterable<string>): void {
    for (const key of keys) for (const done of [...(this.#waiters.get(key) ?? [])]) done();
  }
}

export const DEVICE_NOTIFIER = Symbol('DEVICE_NOTIFIER');
export const ROOM_NOTIFIER = Symbol('ROOM_NOTIFIER');
