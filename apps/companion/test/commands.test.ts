import { describe, expect, test } from 'vitest';
import { StateCache } from '../src/core/cache.ts';
import { createClock } from '../src/core/clock.ts';
import { CommandProcessor } from '../src/core/commands.ts';
import { HubError } from '../src/core/hub-client.ts';
import { OverlayController } from '../src/core/overlay.ts';

const LESSON = '7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a';
const DEVICE = '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';
let counter = 0;

function command(type: string, sequence: string, payload: Record<string, unknown> = {}) {
  counter++;
  return {
    commandId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    sequence,
    targetDeviceId: DEVICE,
    lessonId: LESSON,
    issuedAt: '2026-11-02T08:00:00.000Z',
    expiresAt: '2026-11-02T08:01:00.000Z',
    type,
    payload,
  };
}

interface Receipt {
  id: string;
  body: Record<string, unknown>;
}

function setup(failures: { path: RegExp; times: number; error: HubError }[] = []) {
  const receipts: Receipt[] = [];
  const attempts: string[] = [];
  const hub = {
    json: async (method: string, path: string, body: unknown) => {
      attempts.push(`${method} ${path}`);
      for (const f of failures) {
        if (f.path.test(path) && f.times > 0) {
          f.times--;
          throw f.error;
        }
      }
      const id = path.split('/').at(-2) ?? '';
      receipts.push({ id, body: body as Record<string, unknown> });
      return undefined as never;
    },
  };
  const cache = StateCache.open(':memory:');
  const clock = createClock({ perfNowMs: () => 0, uptimeSeconds: () => 5_000, wallMs: () => 1_800_000_000_000 });
  const overlay = new OverlayController(clock, cache, () => {});
  const messages: string[] = [];
  const processor = new CommandProcessor({
    hub,
    cache,
    overlay,
    ui: { showMessage: (text) => messages.push(text) },
    now: () => 1_800_000_000_000,
    retryDelayMs: 1,
  });
  return { processor, receipts, attempts, overlay, cache, messages };
}

const statusesOf = (receipts: Receipt[], id: string) =>
  receipts
    .filter((r) => r.id === id)
    .map((r) => (r.body.status === 'failed' ? `failed:${r.body.reason}` : r.body.status));

describe('command processor', () => {
  test('a message is shown, acknowledged and then reported succeeded', async () => {
    const t = setup();
    const cmd = command('message.show', '5', { text: 'Daftarlarni oching' });
    await t.processor.handleBatch([cmd]);
    expect(t.messages).toEqual(['Daftarlarni oching']);
    expect(statusesOf(t.receipts, cmd.commandId)).toEqual(['acknowledged', 'succeeded']);
    expect(t.cache.outcomeOf(cmd.commandId)).toEqual({ status: 'succeeded' });
  });

  test('a redelivered command is not executed twice', async () => {
    const t = setup();
    const cmd = command('message.show', '5', { text: 'Salom' });
    await t.processor.handleBatch([cmd]);
    await t.processor.handleBatch([cmd]);
    expect(t.messages).toEqual(['Salom']);
    // Ikkinchi yetkazishda faqat yakuniy receipt qayta yuboriladi (ack allaqachon berilgan).
    expect(statusesOf(t.receipts, cmd.commandId)).toEqual(['acknowledged', 'succeeded', 'succeeded']);
  });

  test('a redelivered failed command repeats its failure and does not run again', async () => {
    const t = setup();
    const cmd = command('message.show', '5', { text: '' });
    await t.processor.handleBatch([cmd]);
    await t.processor.handleBatch([cmd]);
    expect(statusesOf(t.receipts, cmd.commandId)).toEqual(['acknowledged', 'failed:error', 'failed:error']);
  });

  test('commands run in sequence order, compared as numbers', async () => {
    const t = setup();
    const ten = command('overlay.lock', '10', { message: 'ten' });
    const nine = command('overlay.lock', '9', { message: 'nine' });
    const twenty = command('overlay.unlock', '20');
    await t.processor.handleBatch([twenty, ten, nine]);
    expect(t.receipts.map((r) => `${r.id.slice(-2)}:${r.body.status}`)).toEqual(
      [nine, ten, twenty].flatMap((c) => [
        `${c.commandId.slice(-2)}:acknowledged`,
        `${c.commandId.slice(-2)}:succeeded`,
      ]),
    );
    // Satr tartibida '10' < '9' bo'lardi; son tartibida oxirgi holat unlock.
    expect(t.overlay.view()).toEqual({ locked: false, message: null, lessonId: LESSON });
  });

  test('a stale overlay command is reported succeeded without changing the overlay', async () => {
    const t = setup();
    t.overlay.applyCommand({ type: 'overlay.lock', sequence: '10', lessonId: LESSON, message: 'Diqqat' });
    const stale = command('overlay.unlock', '9');
    await t.processor.handleBatch([stale]);
    expect(statusesOf(t.receipts, stale.commandId)).toEqual(['acknowledged', 'succeeded']);
    expect(t.overlay.view()).toEqual({ locked: true, message: 'Diqqat', lessonId: LESSON });
  });

  test('a malformed payload fails with error and runs nothing', async () => {
    const t = setup();
    const noText = command('message.show', '5', {});
    const badMessage = command('overlay.lock', '6', { message: 123 });
    const extra = command('overlay.unlock', '7', { surprise: true });
    await t.processor.handleBatch([noText, badMessage, extra]);
    for (const c of [noText, badMessage, extra]) {
      expect(statusesOf(t.receipts, c.commandId), c.type).toEqual(['acknowledged', 'failed:error']);
    }
    expect(t.messages).toEqual([]);
    expect(t.overlay.view().locked).toBe(false);
  });

  test('an unknown command type is reported unsupported', async () => {
    const t = setup();
    const cmd = command('screen.capture', '5', { anything: 1 });
    await t.processor.handleBatch([cmd]);
    expect(statusesOf(t.receipts, cmd.commandId)).toEqual(['acknowledged', 'failed:unsupported']);
  });

  test('entries the device cannot even identify are ignored', async () => {
    const t = setup();
    await t.processor.handleBatch([null, 'x', { type: 'message.show' }, { commandId: 'nope', sequence: '1' }]);
    expect(t.attempts).toEqual([]);
  });

  test('a command the hub refuses to acknowledge is not executed', async () => {
    const t = setup([{ path: /receipt/, times: 1, error: new HubError('http', 'Conflict', 409, 'conflict') }]);
    const cmd = command('message.show', '5', { text: 'Bekor qilingan' });
    await t.processor.handleBatch([cmd]);
    expect(t.messages).toEqual([]);
    expect(t.cache.outcomeOf(cmd.commandId)).toBeNull();
    expect(t.attempts).toHaveLength(1); // 4xx qayta urinilmaydi
  });

  test('a lost final receipt is retried and the command is still executed once', async () => {
    const network = new HubError('network', 'down');
    const t = setup();
    const cmd = command('message.show', '5', { text: 'Salom' });
    let calls = 0;
    const hub = {
      json: async (_method: string, path: string, body: unknown) => {
        calls++;
        if (calls === 2 || calls === 3) throw network; // ack o'tdi, yakuniy receipt ikki marta yo'qoldi
        t.receipts.push({ id: path.split('/').at(-2) ?? '', body: body as Record<string, unknown> });
        return undefined as never;
      },
    };
    const processor = new CommandProcessor({
      hub,
      cache: t.cache,
      overlay: t.overlay,
      ui: { showMessage: (text: string) => t.messages.push(text) },
      now: () => 1,
      retryDelayMs: 1,
    });
    await processor.handleBatch([cmd]);
    expect(t.messages).toEqual(['Salom']);
    expect(statusesOf(t.receipts, cmd.commandId)).toEqual(['acknowledged', 'succeeded']);
    expect(calls).toBe(4);
  });

  test('an acknowledgement that cannot be delivered leaves the command for redelivery', async () => {
    const network = new HubError('network', 'down');
    const t = setup([{ path: /receipt/, times: 99, error: network }]);
    const cmd = command('message.show', '5', { text: 'Salom' });
    await expect(t.processor.handleBatch([cmd])).rejects.toBe(network);
    expect(t.messages).toEqual([]);
    expect(t.cache.outcomeOf(cmd.commandId)).toBeNull();
  });
});
