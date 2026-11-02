import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

// Qurilmadagi per-user holat: bajarilgan buyruqlar (takroriy yetkazishni qayta bajarmaslik) va overlay lease.
// Kadrlar va matnlar bu yerga yozilmaydi.
export interface PersistedOverlay {
  lessonId: string;
  locked: boolean;
  sequence: string | null;
  message: string | null;
  bootTimeMs: number;
  deadlineUptimeMs: number;
}

export type CommandOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; reason: 'unsupported' | 'permission_required' | 'error' };

const MAX_OUTCOMES = 1_000;
const OUTCOME_TTL_MS = 24 * 60 * 60 * 1000;

const overlaySchema = z.strictObject({
  lessonId: z.string(),
  locked: z.boolean(),
  sequence: z.string().nullable(),
  message: z.string().nullable(),
  bootTimeMs: z.number(),
  deadlineUptimeMs: z.number(),
});

const outcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded') }),
  z.strictObject({ status: z.literal('failed'), reason: z.enum(['unsupported', 'permission_required', 'error']) }),
]);

export class StateCache {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static open(file: string): StateCache {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS outcomes (
        command_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reason TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outcomes_by_time ON outcomes (at);
      CREATE TABLE IF NOT EXISTS overlay (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
    `);
    return new StateCache(db);
  }

  outcomeOf(commandId: string): CommandOutcome | null {
    const row = this.#db.prepare('SELECT status, reason FROM outcomes WHERE command_id = ?').get(commandId);
    if (!row) return null;
    const parsed = outcomeSchema.safeParse(row.status === 'failed' ? row : { status: row.status });
    return parsed.success ? parsed.data : null;
  }

  // Oxirgi 1000 ta va 24 soatdan yangisi saqlanadi (`at` — chaqiruvchining vaqti).
  recordOutcome(commandId: string, outcome: CommandOutcome, at: number): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO outcomes (command_id, status, reason, at) VALUES (?, ?, ?, ?)')
      .run(commandId, outcome.status, outcome.status === 'failed' ? outcome.reason : null, at);
    this.#db.prepare('DELETE FROM outcomes WHERE at < ?').run(at - OUTCOME_TTL_MS);
    this.#db
      .prepare(
        'DELETE FROM outcomes WHERE command_id NOT IN (SELECT command_id FROM outcomes ORDER BY at DESC, rowid DESC LIMIT ?)',
      )
      .run(MAX_OUTCOMES);
  }

  saveOverlay(state: PersistedOverlay | null): void {
    if (state === null) this.#db.exec('DELETE FROM overlay');
    else this.#db.prepare('INSERT OR REPLACE INTO overlay (id, json) VALUES (1, ?)').run(JSON.stringify(state));
  }

  // Buzilgan qator "overlay yo'q" deb o'qiladi: noma'lum holat qulfni ushlab turmaydi.
  loadOverlay(): PersistedOverlay | null {
    const row = this.#db.prepare('SELECT json FROM overlay WHERE id = 1').get();
    if (!row) return null;
    try {
      const parsed = overlaySchema.safeParse(JSON.parse(String(row.json)));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.#db.close();
  }
}
