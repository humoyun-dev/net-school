import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ExtensionReport, WebPolicyPush } from '../src/core/policy-sync.ts';
import { MAX_LINE_BYTES, startWebPipe } from '../src/main/web-pipe.ts';

let dir: string;
let path: string;
let current: WebPolicyPush;
let reports: ExtensionReport[];
let listener: ((p: WebPolicyPush) => void) | null;
let pipe: { close(): Promise<void> } | null;

const push = (hash: string): WebPolicyPush => ({
  baseline: { revision: { org: 1, site: 0 }, hash, blocked: ['bad.com'] },
  lesson: null,
});

function client(): Promise<{ socket: Socket; lines: unknown[]; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const lines: unknown[] = [];
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    socket.once('connect', () => resolve({ socket, lines, closed }));
    socket.once('error', reject);
  });
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ns-pipe-'));
  path = join(dir, 'web.sock');
  current = push('1'.repeat(64));
  reports = [];
  listener = null;
  pipe = await startWebPipe(path, { current: () => current, onExtensionReport: (r) => reports.push(r) }, (fn) => {
    listener = fn;
    return () => {
      listener = null;
    };
  });
});
afterEach(async () => {
  await pipe?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('web pipe', () => {
  test('pushes current policy on connect and on change', async () => {
    const c = await client();
    await until(() => c.lines.length === 1);
    expect(c.lines[0]).toEqual({ type: 'policy', ...current });
    const next = push('2'.repeat(64));
    listener?.(next);
    await until(() => c.lines.length === 2);
    expect(c.lines[1]).toEqual({ type: 'policy', ...next });
    c.socket.destroy();
  });

  test('applied report reaches policy sync', async () => {
    const c = await client();
    const report = { browser: 'chrome', extensionVersion: '1.2.0', baselineHash: '1'.repeat(64), lessonHash: null };
    c.socket.write(`${JSON.stringify({ type: 'applied', ...report })}\n`);
    await until(() => reports.length === 1);
    expect(reports[0]).toEqual(report);
    c.socket.destroy();
  });

  test('malformed line closes the connection', async () => {
    const c = await client();
    c.socket.write('{"type":"applied","browser":"firefox"}\n');
    await c.closed;
    expect(reports).toEqual([]);
  });

  test('oversized line closes the connection', async () => {
    const c = await client();
    c.socket.write('x'.repeat(MAX_LINE_BYTES + 1));
    await c.closed;
  });
});
