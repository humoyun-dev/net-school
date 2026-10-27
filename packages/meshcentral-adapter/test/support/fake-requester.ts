import type { MeshRequester } from '../../src/control-client.ts';
import { AdapterError } from '../../src/errors.ts';

type Reply = Record<string, unknown> | AdapterError;

// MeshRequester'ning xotiradagi o'xshashi: yuborilgan so'rovlarni yozadi, oldindan berilgan javoblarni qaytaradi.
export class FakeRequester implements MeshRequester {
  readonly sent: { action: string; payload: Record<string, unknown> }[] = [];
  readonly replies = new Map<string, Reply>();
  readonly #messageHandlers = new Set<(msg: unknown) => void>();
  readonly #resyncHandlers = new Set<() => void>();

  async request<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ action, payload });
    const reply = this.replies.get(action) ?? { action, result: 'ok' };
    if (reply instanceof AdapterError) throw reply;
    return reply as T;
  }

  onMessage(handler: (msg: unknown) => void) {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onResync(handler: () => void) {
    this.#resyncHandlers.add(handler);
    return () => this.#resyncHandlers.delete(handler);
  }

  emit(msg: unknown) {
    for (const h of this.#messageHandlers) h(msg);
  }

  resync() {
    for (const h of this.#resyncHandlers) h();
  }
}
