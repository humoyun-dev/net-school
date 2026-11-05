import { type KeyEvent, KeyPolicy, type KeyVerdict } from './key-policy.ts';
import type { LockPolicy } from './lock-policy.ts';

// Klaviatura hook'i (Windows'da koffi bilan, main/win-keyboard-hook.ts). `install` o'rnatolmasa xato tashlaydi.
export interface KeyboardHook {
  install(handler: (event: KeyEvent) => KeyVerdict): void;
  uninstall(): void;
}

export type HardLockReason =
  | 'unsupported_os'
  | 'hook_unavailable'
  | 'hook_failed'
  | 'policy_failed'
  | 'policy_restore_failed';

export interface HardLockFacts {
  enforced: boolean;
  reason?: HardLockReason;
}

export interface HardLockDeps {
  policy: LockPolicy;
  hook: KeyboardHook;
  keys?: KeyPolicy;
  // Qo'shimcha hodisalar uchun (log); xato sabablari faqat shu yerga yetadi, hub'ga emas.
  onError?: (reason: HardLockReason, err: unknown) => void;
}

// Kuchli bloklash (ADR 0012, 2-qaror): lock bo'lsa klaviatura hook + reestr siyosati, unlock bo'lsa ikkalasi qaytariladi.
// Biri o'rnatilmasa, ikkinchisi baribir qoladi (ko'proq himoya), lekin qurilma "kuchli" deb da'vo qilmaydi.
// Chaqiruvlar ketma-ket bajariladi (overlay holati tez o'zgarsa ham poyga bo'lmasin).
export class HardLock {
  readonly #deps: HardLockDeps;
  readonly #keys: KeyPolicy;
  #queue: Promise<void> = Promise.resolve();
  #failure: HardLockReason | null = null;
  #restoreFailed = false;
  #hookInstalled = false;

  constructor(deps: HardLockDeps) {
    this.#deps = deps;
    this.#keys = deps.keys ?? new KeyPolicy();
  }

  // Joriy holat: o'rnatishda xato bo'lmagan bo'lsa "kuchli" mumkin. Tiklanmay qolgan siyosat alohida sabab.
  facts(): HardLockFacts {
    const reason = this.#failure ?? (this.#restoreFailed ? 'policy_restore_failed' : null);
    return reason ? { enforced: false, reason } : { enforced: true };
  }

  // Ishga tushganda: oldingi ishga tushishdan qolgan siyosat qaytariladi (lock keyin overlay'dan qayta qo'llanadi).
  start(): Promise<void> {
    return this.#run(() => this.#release());
  }

  set(locked: boolean): Promise<void> {
    return this.#run(() => (locked ? this.#engage() : this.#release()));
  }

  // Qaytarilmay qolgan siyosatni qayta urinish (davriy chaqiriladi).
  retryRestore(): Promise<void> {
    return this.#run(async () => {
      if (this.#restoreFailed || this.#deps.policy.hasPendingRestore()) await this.#release();
    });
  }

  dispose(): Promise<void> {
    return this.#run(() => this.#release());
  }

  #run(task: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #engage(): Promise<void> {
    this.#failure = null;
    this.#keys.reset();
    try {
      await this.#deps.policy.apply();
    } catch (err) {
      this.#fail('policy_failed', err);
    }
    if (!this.#hookInstalled) {
      try {
        this.#deps.hook.install((event) => this.#keys.handle(event));
        this.#hookInstalled = true;
      } catch (err) {
        this.#fail('hook_failed', err);
      }
    }
  }

  async #release(): Promise<void> {
    this.#failure = null;
    if (this.#hookInstalled) {
      try {
        this.#deps.hook.uninstall();
      } catch (err) {
        this.#deps.onError?.('hook_failed', err);
      }
      this.#hookInstalled = false;
    }
    this.#keys.reset();
    try {
      await this.#deps.policy.restore();
      this.#restoreFailed = false;
    } catch (err) {
      this.#restoreFailed = true;
      this.#deps.onError?.('policy_restore_failed', err);
    }
  }

  #fail(reason: HardLockReason, err: unknown): void {
    this.#failure ??= reason;
    this.#deps.onError?.(reason, err);
  }
}
