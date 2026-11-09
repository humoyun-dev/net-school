// Windows low-level klaviatura hook'i alohida oqimda (worker_threads). Windows hook callback'ini o'rnatgan oqimning
// xabar siklida chaqiradi va javob LowLevelHooksTimeout ichida kelmasa hook'ni jimgina olib tashlaydi. Electron asosiy
// oqimi (miniatura, IPC, oynalar) band bo'lganda shunday bo'lardi (T6 sinovi, 2026-11-09): birinchi bosish to'silib,
// keyingilari o'tib ketardi. Bu oqim faqat GetMessageW siklida turadi va toza KeyPolicy'ni chaqiradi.
import { parentPort } from 'node:worker_threads';
import { KeyPolicy } from '../core/key-policy.ts';
import { loadKoffi } from './koffi.ts';

export type HookThreadMessage = { type: 'installed'; threadId: number } | { type: 'failed'; message: string };

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WM_KEYUP = 0x0101;
const WM_SYSKEYUP = 0x0105;
const PM_NOREMOVE = 0;
// MSG x64'da 48 bayt; zaxira bilan.
const MSG_SIZE = 64;

function run(): void {
  const port = parentPort;
  if (!port) throw new Error('keyboard hook thread must run in a worker');
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
  const unhook = user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)');
  const getMessage = user32.func('int __stdcall GetMessageW(void *msg, void *hwnd, uint32 min, uint32 max)');
  const peekMessage = user32.func(
    'bool __stdcall PeekMessageW(void *msg, void *hwnd, uint32 min, uint32 max, uint32 remove)',
  );
  const getModule = kernel32.func('void *__stdcall GetModuleHandleW(const wchar_t *name)');
  const getThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
  const getLastError = kernel32.func('uint32 __stdcall GetLastError()');

  // Har o'rnatish yangi oqim: oldingi bloklashdan qolgan modifier holati bo'lmaydi.
  const keys = new KeyPolicy();
  const callback = koffi.register((nCode: number, wParam: number, lParam: unknown) => {
    if (nCode >= 0) {
      const k = koffi.decode(lParam, KBDLLHOOKSTRUCT);
      const w = Number(wParam);
      const kind = w === WM_KEYDOWN || w === WM_SYSKEYDOWN ? 'down' : w === WM_KEYUP || w === WM_SYSKEYUP ? 'up' : null;
      if (kind && keys.handle({ vkCode: k.vkCode, flags: k.flags, kind }) === 'block') return 1;
    }
    return callNext(null, nCode, wParam, lParam);
  }, koffi.pointer(HOOKPROC));

  const msg = Buffer.alloc(MSG_SIZE);
  // Oqim xabar navbatini yaratadi: asosiy oqimning PostThreadMessageW(WM_QUIT) shundan keyin yetib boradi.
  peekMessage(msg, null, 0, 0, PM_NOREMOVE);
  const handle = setHook(WH_KEYBOARD_LL, callback, getModule(null), 0);
  if (!handle) {
    const code = getLastError();
    koffi.unregister(callback);
    port.postMessage({ type: 'failed', message: `SetWindowsHookExW failed (${code})` } satisfies HookThreadMessage);
    return;
  }
  port.postMessage({ type: 'installed', threadId: Number(getThreadId()) } satisfies HookThreadMessage);
  // WM_QUIT kelganda 0, xatoda -1.
  while ((getMessage(msg, null, 0, 0) as number) > 0) {}
  unhook(handle);
  koffi.unregister(callback);
}

run();
