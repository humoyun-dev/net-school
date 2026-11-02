import { z } from 'zod';
import type { CommandOutcome, StateCache } from './cache.ts';
import { type HubClient, HubError } from './hub-client.ts';
import type { OverlayController } from './overlay.ts';

export interface CommandUi {
  showMessage(text: string): void;
}

// Noma'lum `type` ham o'qiladi: yangi hub eski Companion'ga yangi buyruq yuborsa `unsupported` deb javob beriladi.
const commandSchema = z.object({
  commandId: z.uuid(),
  sequence: z.string().regex(/^\d{1,30}$/),
  lessonId: z.uuid(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
type Command = z.infer<typeof commandSchema>;

const messagePayload = z.strictObject({ text: z.string().min(1).max(500) });
const lockPayload = z.strictObject({ message: z.string().max(200).optional() });
const unlockPayload = z.strictObject({});

const ERROR: CommandOutcome = { status: 'failed', reason: 'error' };
const RECEIPT_ATTEMPTS = 3;

type Receipt = { status: 'acknowledged' } | { status: 'succeeded' } | { status: 'failed'; reason: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Hub buyruqlarini bajaradi (at-least-once yetkazish): bajarilgan buyruq qayta bajarilmaydi, faqat natijasi qayta yuboriladi.
export class CommandProcessor {
  readonly #hub: Pick<HubClient, 'json'>;
  readonly #cache: StateCache;
  readonly #overlay: OverlayController;
  readonly #ui: CommandUi;
  readonly #now: () => number;
  readonly #retryDelayMs: number;

  constructor(deps: {
    hub: Pick<HubClient, 'json'>;
    cache: StateCache;
    overlay: OverlayController;
    ui: CommandUi;
    now?: () => number;
    retryDelayMs?: number;
  }) {
    this.#hub = deps.hub;
    this.#cache = deps.cache;
    this.#overlay = deps.overlay;
    this.#ui = deps.ui;
    this.#now = deps.now ?? Date.now;
    this.#retryDelayMs = deps.retryDelayMs ?? 250;
  }

  // `sequence` bo'yicha o'sish tartibida (son sifatida: '9' < '10'). Tarmoq xatosi qolganlarini to'xtatadi — ular qayta yetkaziladi.
  async handleBatch(batch: readonly unknown[]): Promise<void> {
    const commands = batch.flatMap((raw) => {
      const parsed = commandSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    commands.sort((a, b) => {
      const diff = BigInt(a.sequence) - BigInt(b.sequence);
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    });
    for (const command of commands) await this.#handle(command);
  }

  async #handle(command: Command): Promise<void> {
    const stored = this.#cache.outcomeOf(command.commandId);
    if (stored) {
      await this.#send(command.commandId, receiptOf(stored));
      return;
    }
    // Ack avval: hub qabul qilmasa (masalan bekor qilingan) buyruq bajarilmaydi.
    if ((await this.#send(command.commandId, { status: 'acknowledged' })) === 'refused') return;
    const outcome = this.#execute(command);
    this.#cache.recordOutcome(command.commandId, outcome, this.#now());
    await this.#send(command.commandId, receiptOf(outcome));
  }

  #execute(command: Command): CommandOutcome {
    try {
      switch (command.type) {
        case 'message.show': {
          const payload = messagePayload.safeParse(command.payload);
          if (!payload.success) return ERROR;
          this.#ui.showMessage(payload.data.text);
          return { status: 'succeeded' };
        }
        case 'overlay.lock': {
          const payload = lockPayload.safeParse(command.payload);
          if (!payload.success) return ERROR;
          this.#applyOverlay(command, payload.data.message);
          return { status: 'succeeded' };
        }
        case 'overlay.unlock': {
          if (!unlockPayload.safeParse(command.payload).success) return ERROR;
          this.#applyOverlay(command);
          return { status: 'succeeded' };
        }
        default:
          return { status: 'failed', reason: 'unsupported' };
      }
    } catch {
      return ERROR;
    }
  }

  // `stale` ham muvaffaqiyat: qurilma allaqachon yangiroq holatda.
  #applyOverlay(command: Command, message?: string): void {
    this.#overlay.applyCommand({
      type: command.type as 'overlay.lock' | 'overlay.unlock',
      sequence: command.sequence,
      lessonId: command.lessonId,
      ...(message ? { message } : {}),
    });
  }

  // 4xx — hub shu receipt'ni qabul qilmaydi (terminal/bekor qilingan): qayta urinilmaydi. Tarmoq/5xx — qisqa qayta urinish,
  // ack yetmasa xato ko'tariladi va buyruq qayta yetkaziladi.
  async #send(commandId: string, receipt: Receipt): Promise<'ok' | 'refused'> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#hub.json('POST', `/api/v1/device/commands/${commandId}/receipt`, receipt, null);
        return 'ok';
      } catch (err) {
        if (err instanceof HubError && err.kind === 'http' && err.status !== null && err.status < 500) return 'refused';
        if (attempt >= RECEIPT_ATTEMPTS) throw err;
        await sleep(this.#retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}

function receiptOf(outcome: CommandOutcome): Receipt {
  return outcome.status === 'succeeded' ? { status: 'succeeded' } : { status: 'failed', reason: outcome.reason };
}
