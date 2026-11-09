import type { LockPolicy } from './lock-policy.ts';

// Klaviatura hook'i (Windows'da main/win-keyboard-hook.ts: alohida oqim, ichida KeyPolicy). `install` o'rnatolmasa
// rad etiladi; o'rnatilgandan keyin hook yo'qolsa (oqim o'ldi va h.k.) `onLost` chaqiriladi.
export interface KeyboardHook {
  install(onLost: (err: unknown) => void): Promise<void>;
  uninstall(): Promise<void>;
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
  // Qo'shimcha hodisalar uchun (log); xato sabablari faqat shu yerga yetadi, hub'ga emas.
  onError?: (reason: HardLockReason, err: unknown) => void;
}

// Kuchli bloklash (ADR 0012, 2-qaror): lock bo'lsa klaviatura hook + reestr siyosati, unlock bo'lsa ikkalasi qaytariladi.
// Biri o'rnatilmasa, ikkinchisi baribir qoladi (ko'proq himoya), lekin qurilma "kuchli" deb da'vo qilmaydi.
// Chaqiruvlar ketma-ket bajariladi (overlay holati tez o'zgarsa ham poyga bo'lmasin).
export class HardLock {
  readonly #deps: HardLockDeps;
  #queue: Promise<void> = Promise.resolve();
  #failure: HardLockReason | null = null;
  #restoreFailed = false;
  #hookInstalled = false;
  // Overlay so'ragan holat: lock faol bo'lsa jurnal to'la bo'lishi kutilgan, uni "qolib ketgan" deb qaytarib bo'lmaydi.
  #locked = false;

  constructor(deps: HardLockDeps) {
    this.#deps = deps;
  }

  // Joriy holat: o'rnatishda xato bo'lmagan bo'lsa "kuchli" mumkin. Tiklanmay qolgan siyosat alohida sabab.
  facts(): HardLockFacts {
    const reason = this.#failure ?? (this.#restoreFailed ? 'policy_restore_failed' : null);
    return reason ? { enforced: false, reason } : { enforced: true };
  }

  // Ishga tushganda: oldingi ishga tushishdan qolgan siyosat qaytariladi (lock keyin overlay'dan qayta qo'llanadi).
  start(): Promise<void> {
    return this.#run(() => this.#unlock());
  }

  set(locked: boolean): Promise<void> {
    return this.#run(() => {
      if (!locked) return this.#unlock();
      this.#locked = true;
      return this.#engage();
    });
  }

  // Qaytarilmay qolgan siyosatni qayta urinish (davriy chaqiriladi). Faol bloklashga tegmaydi.
  retryRestore(): Promise<void> {
    return this.#run(async () => {
      if (this.#locked) return;
      if (this.#restoreFailed || this.#deps.policy.hasPendingRestore()) await this.#release();
    });
  }

  dispose(): Promise<void> {
    return this.#run(() => this.#unlock());
  }

  #unlock(): Promise<void> {
    this.#locked = false;
    return this.#release();
  }

  #run(task: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #engage(): Promise<void> {
    this.#failure = null;
    try {
      await this.#deps.policy.apply();
    } catch (err) {
      this.#fail('policy_failed', err);
    }
    if (!this.#hookInstalled) {
      try {
        await this.#deps.hook.install((err) => {
          this.#hookInstalled = false;
          this.#fail('hook_failed', err);
        });
        this.#hookInstalled = true;
      } catch (err) {
        this.#fail('hook_failed', err);
      }
    }
  }

  async #release(): Promise<void> {
    this.#failure = null;
    if (this.#hookInstalled) {
      this.#hookInstalled = false;
      try {
        await this.#deps.hook.uninstall();
      } catch (err) {
        this.#deps.onError?.('hook_failed', err);
      }
    }
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
