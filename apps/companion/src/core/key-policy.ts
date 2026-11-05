// Bloklash paytida to'siladigan Windows tugma kombinatsiyalari (ADR 0012, 2-qaror). Toza mantiq: native va Electron yo'q,
// hook callback'i shu predicate'ni chaqiradi va boshqa hech narsa qilmaydi (callback juda sekin bo'lsa Windows hook'ni o'chiradi).

export const VK = {
  TAB: 0x09,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  F4: 0x73,
  LWIN: 0x5b,
  RWIN: 0x5c,
} as const;

// KBDLLHOOKSTRUCT.flags bitlari.
export const LLKHF_ALTDOWN = 0x20;
export const LLKHF_INJECTED = 0x10;

const CTRL_KEYS: ReadonlySet<number> = new Set([0x11, 0xa2, 0xa3]);
const ALT_KEYS: ReadonlySet<number> = new Set([0x12, 0xa4, 0xa5]);

export interface KeyEvent {
  vkCode: number;
  flags: number;
  kind: 'down' | 'up';
}

export type KeyVerdict = 'pass' | 'block';

// Hodisalar ketma-ketligini kuzatadi: modifier holati va to'silgan tugmaning "up"i (aks holda Win'ning "up"i Start'ni ochadi).
export class KeyPolicy {
  readonly #held = new Set<number>();
  readonly #swallowed = new Set<number>();

  handle(event: KeyEvent): KeyVerdict {
    // Dasturiy yuborilgan kiritish (MeshAgent orqali o'qituvchining masofaviy boshqaruvi) hech qachon to'silmaydi
    // va modifier holatiga ta'sir qilmaydi.
    if ((event.flags & LLKHF_INJECTED) !== 0) return 'pass';

    if (event.kind === 'up') {
      this.#held.delete(event.vkCode);
      if (this.#swallowed.delete(event.vkCode)) return 'block';
      return 'pass';
    }

    this.#held.add(event.vkCode);
    if (this.#isBlocked(event)) {
      this.#swallowed.add(event.vkCode);
      return 'block';
    }
    return 'pass';
  }

  // Bloklash tugaganda yoki hook qayta o'rnatilganda eski holat qolmasligi uchun.
  reset(): void {
    this.#held.clear();
    this.#swallowed.clear();
  }

  #anyHeld(keys: ReadonlySet<number>): boolean {
    for (const key of this.#held) if (keys.has(key)) return true;
    return false;
  }

  #isBlocked(event: KeyEvent): boolean {
    const vk = event.vkCode;
    if (vk === VK.LWIN || vk === VK.RWIN) return true;
    const alt = this.#anyHeld(ALT_KEYS) || (event.flags & LLKHF_ALTDOWN) !== 0;
    const ctrl = this.#anyHeld(CTRL_KEYS);
    if (alt && (vk === VK.TAB || vk === VK.ESCAPE || vk === VK.F4 || vk === VK.SPACE)) return true;
    // Ctrl+Esc (Start) va Ctrl+Shift+Esc (Vazifalar menejeri): Shift natijaga ta'sir qilmaydi, ikkalasi ham to'siladi.
    if (ctrl && vk === VK.ESCAPE) return true;
    return false;
  }
}
