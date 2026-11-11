// Overlay renderer'i yo'qolganda (o'quvchi uni o'ldirgan yoki u qulagan) sahifa qayta yuklanadi. Cheksiz sikl
// (har o'ldirishga darhol reload) CPU'ni band qiladi, shuning uchun har oynada `max` ta reload `windowMs` ichida;
// undan ortig'i eng eski slot bo'shaguncha kechiktiriladi. Shu orada oyna qoladi (bo'sh, lekin ekranni qoplaydi).
export class ReloadBudget {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #nowMs: () => number;
  // Rejalashtirilgan reload vaqtlari (o'sib boruvchi, kelajakdagilari ham).
  #slots: number[] = [];

  constructor(opts: { max: number; windowMs: number; nowMs: () => number }) {
    this.#max = opts.max;
    this.#windowMs = opts.windowMs;
    this.#nowMs = opts.nowMs;
  }

  // Keyingi reload uchun slot band qiladi va qancha kutish kerakligini qaytaradi (0 — darhol).
  reserve(): number {
    const now = this.#nowMs();
    this.#slots = this.#slots.filter((t) => t > now - this.#windowMs);
    let at = now;
    if (this.#slots.length >= this.#max) {
      const freed = (this.#slots[this.#slots.length - this.#max] as number) + this.#windowMs;
      at = Math.max(now, freed);
    }
    this.#slots.push(at);
    return at - now;
  }
}

// `clean-exit` — renderer o'zi to'xtadi (oyna yopilmoqda): qayta yuklanmaydi.
export function shouldReloadOverlay(reason: string): boolean {
  return reason !== 'clean-exit';
}
