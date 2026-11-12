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

// Overlay renderer'i yo'qolganda nima qilinadi. Oyna `show: false` bilan yaratiladi va `ready-to-show`da
// ko'rsatiladi; renderer birinchi chizishdan oldin o'ldirilsa bu hodisa kelmaydi, shuning uchun oyna har doim darhol
// ko'rsatiladi (bo'sh bo'lsa ham ekranni qoplaydi) — reload kechiksa ham. Sabab (`clean-exit` ham) ahamiyatsiz:
// bloklash paytida overlay renderer'ining o'zi to'xtashi normal emas (`TerminateProcess(h, 0)` `clean-exit` bo'ladi).
// reloadIn: 0 — darhol, son — shuncha ms dan keyin, null — reload allaqachon kutilmoqda.
export function onOverlayGone(budget: ReloadBudget, pending: boolean): { reveal: true; reloadIn: number | null } {
  return { reveal: true, reloadIn: pending ? null : budget.reserve() };
}
