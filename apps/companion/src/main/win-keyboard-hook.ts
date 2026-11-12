import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { KeyboardHook } from '../core/hard-lock.ts';
import type { HookThreadMessage } from './keyboard-hook-thread.ts';
import { loadKoffi } from './koffi.ts';

const WM_QUIT = 0x0012;
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;

export function keyboardHookAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    loadKoffi();
    return true;
  } catch {
    return false;
  }
}

let postThreadMessage: ((threadId: number, msg: number, w: number, l: number) => unknown) | null = null;
function postThreadQuit(threadId: number): void {
  postThreadMessage ??= loadKoffi()
    .load('user32.dll')
    .func('bool __stdcall PostThreadMessageW(uint32 idThread, uint32 Msg, uintptr_t wParam, intptr_t lParam)') as (
    threadId: number,
    msg: number,
    w: number,
    l: number,
  ) => unknown;
  postThreadMessage(threadId, WM_QUIT, 0, 0);
}

// Hook keyboard-hook-thread.cjs oqimida yashaydi (asosiy oqim bandligi hook'ni o'ldirmasin). Bu klass faqat oqimni
// ishga tushiradi va WM_QUIT bilan to'xtatadi.
export class WindowsKeyboardHook implements KeyboardHook {
  readonly #script: string;
  readonly #postQuit: (threadId: number) => void;
  #worker: Worker | null = null;
  #threadId = 0;
  #stopping = false;

  // Testlar soxta oqim skripti va WM_QUIT yuboruvchisini beradi.
  constructor(opts: { script?: string; postQuit?: (threadId: number) => void } = {}) {
    this.#script = opts.script ?? join(__dirname, 'keyboard-hook-thread.cjs');
    this.#postQuit = opts.postQuit ?? postThreadQuit;
  }

  install(onLost: (err: unknown) => void): Promise<void> {
    if (this.#worker) return Promise.resolve();
    const worker = new Worker(this.#script);
    this.#worker = worker;
    this.#stopping = false;
    return new Promise<void>((resolve, reject) => {
      // starting → running → ended: har bir oqim uchun xato yoki yo'qotish faqat bir marta xabar qilinadi.
      let state: 'starting' | 'running' | 'ended' = 'starting';
      const fail = (err: unknown) => {
        if (state === 'ended') return;
        const wasRunning = state === 'running';
        state = 'ended';
        clearTimeout(timer);
        if (this.#worker === worker) this.#worker = null;
        if (!wasRunning) {
          void worker.terminate();
          reject(err);
        } else if (!this.#stopping) {
          onLost(err);
        }
      };
      const timer = setTimeout(() => fail(new Error('keyboard hook thread did not start')), START_TIMEOUT_MS);
      worker.on('message', (m: HookThreadMessage) => {
        if (state !== 'starting') return;
        if (m.type === 'installed') {
          state = 'running';
          clearTimeout(timer);
          this.#threadId = m.threadId;
          resolve();
        } else {
          fail(new Error(m.message));
        }
      });
      worker.on('error', fail);
      worker.on('exit', (code) => fail(new Error(`keyboard hook thread exited (${code})`)));
    });
  }

  async uninstall(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    this.#worker = null;
    this.#stopping = true;
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    this.#postQuit(this.#threadId);
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS).unref());
    // Oqim GetMessageW'dan chiqmasa (kutilmagan), jarayon baribir hook'ni ushlab qolmasin.
    if ((await Promise.race([exited, timeout])) === 'timeout') await worker.terminate();
  }
}
