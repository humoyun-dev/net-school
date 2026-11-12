import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WindowsKeyboardHook } from '../src/main/win-keyboard-hook.ts';

// Haqiqiy oqim GetMessageW'da turadi va WM_QUIT bilan chiqadi; soxta oqim WM_QUIT o'rniga BroadcastChannel'ni kutadi.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hook-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function thread(body: string): string {
  const file = join(dir, `thread-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(file, `const { parentPort } = require('node:worker_threads');\n${body}`);
  return file;
}

const running = () =>
  thread(`
  const quit = new BroadcastChannel('quit-42');
  quit.onmessage = () => { quit.close(); process.exit(0); };
  parentPort.postMessage({ type: 'installed', threadId: 42 });
`);

const postQuit = (threadId: number) => {
  const c = new BroadcastChannel(`quit-${threadId}`);
  c.postMessage('quit');
  c.close();
};

describe('Windows keyboard hook thread', () => {
  test('install waits for the thread to hook, uninstall quits it by thread id', async () => {
    const lost: unknown[] = [];
    const quits: number[] = [];
    const hook = new WindowsKeyboardHook({
      script: running(),
      postQuit: (id) => {
        quits.push(id);
        postQuit(id);
      },
    });
    await hook.install((err) => lost.push(err));
    await hook.install((err) => lost.push(err)); // takror: ikkinchi oqim yo'q
    await hook.uninstall();
    expect(quits).toEqual([42]);
    expect(lost).toEqual([]);
  });

  test('a thread that cannot hook makes install fail', async () => {
    const hook = new WindowsKeyboardHook({
      script: thread(`parentPort.postMessage({ type: 'failed', message: 'SetWindowsHookExW failed (5)' });`),
      postQuit,
    });
    const lost: unknown[] = [];
    await expect(hook.install((err) => lost.push(err))).rejects.toThrow(/SetWindowsHookExW failed/);
    expect(lost).toEqual([]);
  });

  test('a thread that dies after hooking is reported once as lost', async () => {
    const hook = new WindowsKeyboardHook({
      script: thread(`
        parentPort.postMessage({ type: 'installed', threadId: 7 });
        setTimeout(() => process.exit(3), 20);
      `),
      postQuit,
    });
    const lost = new Promise<unknown>((resolve) => {
      void hook.install(resolve);
    });
    expect(String(await lost)).toMatch(/exited \(3\)/);
    // Yo'qolgan oqimdan keyin yangi o'rnatish mumkin.
    const again = new WindowsKeyboardHook({ script: running(), postQuit });
    await again.install(() => {});
    await again.uninstall();
  });
});
