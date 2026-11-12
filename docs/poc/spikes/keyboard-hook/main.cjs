// P2d0 T1 spike: Electron 45 main jarayonida WH_KEYBOARD_LL hook koffi orqali ishlaydimi.
// Faqat Windows'da. 45 soniyadan keyin hook o'zi olib tashlanadi va jarayon chiqadi (xavfsizlik).
// Ishga tushirish: `npm install` keyin `npm start` (tarmoq va admin huquqi shart emas).
'use strict';
const { app } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const RUN_MS = 45_000;
const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
const WM_KEYUP = 0x0101;
const WM_SYSKEYUP = 0x0105;
const LLKHF_INJECTED = 0x10;
const VK = { TAB: 0x09, ESCAPE: 0x1b, F4: 0x73, SPACE: 0x20, LWIN: 0x5b, RWIN: 0x5c };
const CTRL = new Set([0x11, 0xa2, 0xa3]);
const SHIFT = new Set([0x10, 0xa0, 0xa1]);
const ALT = new Set([0x12, 0xa4, 0xa5]);

if (process.platform !== 'win32') {
  console.error('Bu spike faqat Windows uchun.');
  app.exit(2);
}

const report = {
  electron: process.versions.electron,
  node: process.versions.node,
  installed: false,
  events: [],
  blocked: [],
  passed: 0,
  maxCallbackMs: 0,
  error: null,
};
const down = new Set();
const mods = () => ({
  ctrl: [...down].some((k) => CTRL.has(k)),
  shift: [...down].some((k) => SHIFT.has(k)),
  alt: [...down].some((k) => ALT.has(k)),
});

// Bu predicate T2'dagi key-policy.ts ning dastlabki ko'rinishi.
function shouldBlock(vk, m) {
  if (vk === VK.LWIN || vk === VK.RWIN) return 'win';
  if (m.alt && vk === VK.TAB) return 'alt+tab';
  if (m.alt && vk === VK.ESCAPE) return 'alt+esc';
  if (m.alt && vk === VK.F4) return 'alt+f4';
  if (m.alt && vk === VK.SPACE) return 'alt+space';
  if (m.ctrl && vk === VK.ESCAPE) return m.shift ? 'ctrl+shift+esc' : 'ctrl+esc';
  return null;
}

function finish(code) {
  try {
    if (hook && UnhookWindowsHookEx) report.unhooked = UnhookWindowsHookEx(hook);
  } catch (e) {
    report.error = report.error ?? String(e);
  }
  const file = join(process.cwd(), 'spike-result.json');
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nNatija: ${file}`);
  console.log(
    `hook o'rnatildi: ${report.installed}, to'silgan: ${report.blocked.length}, o'tgan: ${report.passed}, eng sekin callback: ${report.maxCallbackMs.toFixed(3)} ms`,
  );
  app.exit(code);
}

let hook = null;
let UnhookWindowsHookEx = null;

app.whenReady().then(() => {
  try {
    const koffi = require('koffi');
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
    const SetWindowsHookExW = user32.func(
      'void *__stdcall SetWindowsHookExW(int idHook, HOOKPROC *lpfn, void *hMod, uint32 dwThreadId)',
    );
    const CallNextHookEx = user32.func(
      'intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, void *lParam)',
    );
    UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)');
    const GetModuleHandleW = kernel32.func('void *__stdcall GetModuleHandleW(const wchar_t *name)');

    const callback = koffi.register((nCode, wParam, lParam) => {
      const t0 = process.hrtime.bigint();
      let swallow = false;
      if (nCode >= 0) {
        const k = koffi.decode(lParam, KBDLLHOOKSTRUCT);
        const isDown = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN;
        const isUp = wParam === WM_KEYUP || wParam === WM_SYSKEYUP;
        const injected = (k.flags & LLKHF_INJECTED) !== 0;
        if (isDown) down.add(k.vkCode);
        if (isUp) down.delete(k.vkCode);
        if (!injected && isDown) {
          const why = shouldBlock(k.vkCode, mods());
          if (why) {
            swallow = true;
            if (report.blocked.length < 200) report.blocked.push({ vk: k.vkCode, why });
          } else report.passed += 1;
        }
        if (!injected && isUp && (k.vkCode === VK.LWIN || k.vkCode === VK.RWIN)) swallow = true; // Win'ning "up"i Start'ni ochmasin
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms > report.maxCallbackMs) report.maxCallbackMs = ms;
      return swallow ? 1 : CallNextHookEx(null, nCode, wParam, lParam);
    }, koffi.pointer(HOOKPROC));

    hook = SetWindowsHookExW(WH_KEYBOARD_LL, callback, GetModuleHandleW(null), 0);
    report.installed = Boolean(hook);
    if (!hook) throw new Error('SetWindowsHookExW null qaytardi');
    console.log(`Hook o'rnatildi. ${RUN_MS / 1000} soniya ichida sinang:`);
    console.log("  TO'SILISHI KERAK: Win, Alt+Tab, Ctrl+Esc, Ctrl+Shift+Esc, Alt+F4, Alt+Space");
    console.log("  O'TISHI KERAK:   oddiy harflar, Ctrl+C, Shift+harf");
    console.log("  Ctrl+Alt+Del va Win+L: hook bilan to'silmaydi (kutilgan; siyosat bilan to'siladi)");
    setTimeout(() => finish(0), RUN_MS);
  } catch (e) {
    report.error = String(e && e.stack ? e.stack : e);
    console.error(report.error);
    finish(1);
  }
});
