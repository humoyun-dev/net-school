import { randomBytes } from 'node:crypto';
import { sha256 } from './hash.ts';

export interface TicketStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

interface TicketEntry {
  sessionId: string;
  expiresAt: number;
}

// Bir martalik ticket: xom matn saqlanmaydi, faqat SHA-256 hash.
export class TicketStore {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, TicketEntry>();

  constructor(opts: TicketStoreOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? 30_000;
    this.#now = opts.now ?? Date.now;
  }

  issue(sessionId: string): { ticket: string; expiresAt: number } {
    this.#prune();
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + this.#ttlMs;
    this.#entries.set(sha256(ticket), { sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  // Qidirish va o'chirish bir sinxron qadamda (await yo'q): redeem atomik.
  redeem(ticket: string): { sessionId: string } | { error: 'unknown' | 'expired' } {
    const hash = sha256(ticket);
    const entry = this.#entries.get(hash);
    if (!entry) return { error: 'unknown' };
    this.#entries.delete(hash);
    if (this.#now() > entry.expiresAt) return { error: 'expired' };
    return { sessionId: entry.sessionId };
  }

  // Muddati o'tgan yozuvlar xotirada to'planib qolmasin.
  #prune(): void {
    const now = this.#now();
    for (const [hash, entry] of this.#entries) {
      if (now > entry.expiresAt) this.#entries.delete(hash);
    }
  }
}
