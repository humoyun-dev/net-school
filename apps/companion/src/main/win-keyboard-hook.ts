import type { KeyboardHook } from '../core/hard-lock.ts';
import type { KeyEvent, KeyVerdict } from '../core/key-policy.ts';

// Windows low-level klaviatura hook (WH_KEYBOARD_LL) koffi orqali. DIQQAT: Windows'da sinalmagan (P2d0 T1 spike natijasi
// kutilmoqda, docs/poc/spikes/keyboard-hook). Hook callback'i faqat toza predicate'ni chaqiradi: Windows
// LowLevelHooksTimeout dan sekin hook'ni jimgina o'chirib tashlaydi.
const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WM_KEYUP = 0x0101;
const WM_SYSKEYUP = 0x0105;

// koffi'ning kerakli qismi (to'liq tip kerak emas; paket Windows'da yetkaziladi).
interface Koffi {
  load(lib: string): { func(signature: string): (...args: unknown[]) => unknown };
  struct(name: string, fields: Record<string, string>): unknown;
  proto(signature: string): unknown;
  pointer(type: unknown): unknown;
  register(fn: (...args: never[]) => unknown, type: unknown): unknown;
  unregister(callback: unknown): void;
  decode(pointer: unknown, type: unknown): { vkCode: number; flags: number };
}

function loadKoffi(): Koffi {
  // Tashqi (bundle'ga kirmaydigan) native paket: yetishmasa xato tashlaydi.
  return require('koffi') as Koffi;
}

export function keyboardHookAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    loadKoffi();
    return true;
  } catch {
    return false;
  }
}

export class WindowsKeyboardHook implements KeyboardHook {
  #handle: unknown = null;
  #callback: unknown = null;
  #koffi: Koffi | null = null;
  #unhook: ((handle: unknown) => unknown) | null = null;

  install(handler: (event: KeyEvent) => KeyVerdict): void {
    if (this.#handle) return;
    const koffi = loadKoffi();
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
      vkCode: 'uint32',
      scanCode: 'uint32',
      flags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    });
    const HOOKPROC = koffi.proto('intptr_t __stdcall HOOKPROC(int nCode, uintptr_t wParam, void *lParam)');
    const setHook = user32.func(
      'void *__stdcall SetWindowsHookExW(int idHook, HOOKPROC *lpfn, void *hMod, uint32 dwThreadId)',
    );
    const callNext = user32.func(
      'intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, void *lParam)',
    );
    const getModule = kernel32.func('void *__stdcall GetModuleHandleW(const wchar_t *name)');
    this.#unhook = user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)') as (h: unknown) => unknown;

    const callback = koffi.register((nCode: number, wParam: number, lParam: unknown) => {
      if (nCode >= 0) {
        const k = koffi.decode(lParam, KBDLLHOOKSTRUCT);
        const kind =
          wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN
            ? 'down'
            : wParam === WM_KEYUP || wParam === WM_SYSKEYUP
              ? 'up'
              : null;
        if (kind && handler({ vkCode: k.vkCode, flags: k.flags, kind }) === 'block') return 1;
      }
      return callNext(null, nCode, wParam, lParam);
    }, koffi.pointer(HOOKPROC));

    const handle = setHook(WH_KEYBOARD_LL, callback, getModule(null), 0);
    if (!handle) {
      koffi.unregister(callback);
      throw new Error('SetWindowsHookExW returned null');
    }
    this.#koffi = koffi;
    this.#callback = callback;
    this.#handle = handle;
  }

  uninstall(): void {
    const handle = this.#handle;
    this.#handle = null;
    if (!handle) return;
    this.#unhook?.(handle);
    if (this.#koffi && this.#callback) this.#koffi.unregister(this.#callback);
    this.#callback = null;
  }
}
