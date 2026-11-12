import type { PersistedPolicyEntry } from './cache.ts';

// Bloklash paytida Ctrl+Alt+Del bandlarini va Win+L'ni o'chiradigan HKCU siyosatlari (hook ularni to'sa olmaydi).
// Windows Home'da ham ishlaydi (Group Policy muharriri kerak emas). Qiymatlar o'zgartirilishidan oldin jurnalga yoziladi,
// shuning uchun Companion o'lib qolsa ham keyingi ishga tushishda hammasi qaytariladi.
export interface RegistryEntry {
  key: string;
  name: string;
}

export interface RegistryPort {
  // null — qiymat yo'q.
  read(entry: RegistryEntry): Promise<number | null>;
  write(entry: RegistryEntry, value: number): Promise<void>;
  remove(entry: RegistryEntry): Promise<void>;
}

export interface JournalStore {
  load(): PersistedPolicyEntry[] | null;
  save(entries: PersistedPolicyEntry[] | null): void;
}

const SYSTEM_POLICY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const EXPLORER_POLICY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer';

export const DISABLE_TASK_MGR: RegistryEntry = { key: SYSTEM_POLICY, name: 'DisableTaskMgr' };

export const LOCK_POLICY: readonly RegistryEntry[] = [
  DISABLE_TASK_MGR,
  { key: SYSTEM_POLICY, name: 'DisableLockWorkstation' },
  { key: SYSTEM_POLICY, name: 'DisableChangePassword' },
  { key: EXPLORER_POLICY, name: 'NoLogoff' },
  { key: EXPLORER_POLICY, name: 'NoWinKeys' },
];

const sameEntry = (a: RegistryEntry, b: RegistryEntry) => a.key === b.key && a.name === b.name;

export class LockPolicy {
  readonly #registry: RegistryPort;
  readonly #store: JournalStore;

  constructor(registry: RegistryPort, store: JournalStore) {
    this.#registry = registry;
    this.#store = store;
  }

  // Siyosatni o'rnatadi. Takroriy chaqiruv xavfsiz: jurnalda bor qiymatning "oldingi" holati qayta yozilmaydi
  // (aks holda bizning o'z qiymatimiz "asl" deb saqlanib qolardi).
  async apply(): Promise<void> {
    const journal = this.#store.load() ?? [];
    for (const entry of LOCK_POLICY) {
      if (journal.some((j) => sameEntry(j, entry))) continue;
      journal.push({ ...entry, previous: await this.#registry.read(entry) });
    }
    // Avval jurnal, keyin qiymatlar: yozish o'rtasida uzilsa ham qaytarish mumkin bo'ladi.
    this.#store.save(journal);
    for (const entry of LOCK_POLICY) await this.#registry.write(entry, 1);
  }

  // Jurnal bo'yicha oldingi holatni tiklaydi. Biror qiymat tiklanmasa, faqat o'sha qoladi jurnalda va xato qaytariladi
  // (keyingi urinish davom ettiradi).
  async restore(): Promise<void> {
    const journal = this.#store.load();
    if (!journal || journal.length === 0) {
      this.#store.save(null);
      return;
    }
    const failed: PersistedPolicyEntry[] = [];
    let firstError: unknown;
    for (const item of journal) {
      try {
        if (item.previous === null) await this.#registry.remove(item);
        else await this.#registry.write(item, item.previous);
      } catch (err) {
        failed.push(item);
        firstError ??= err;
      }
    }
    this.#store.save(failed.length === 0 ? null : failed);
    if (failed.length > 0) throw new Error(`could not restore ${failed.length} policy value(s)`, { cause: firstError });
  }

  // Ishga tushganda: bloklash faol bo'lmasa qolib ketgan siyosat qaytariladi.
  async reconcile(lockActive: boolean): Promise<void> {
    if (lockActive) return;
    await this.restore();
  }

  hasPendingRestore(): boolean {
    const journal = this.#store.load();
    return journal !== null && journal.length > 0;
  }
}
