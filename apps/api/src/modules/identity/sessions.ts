import { createHash, randomBytes } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { authSessions } from '../../db/schema.ts';

export const SESSION_COOKIE = '__Host-ns_sid';
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60_000;

const hash = (token: string) => createHash('sha256').update(token).digest();

// Server tomonidagi sessiya: brauzerda faqat tasodifiy token, DB'da uning SHA-256'i.
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly opts: { now: () => number; idleMs: number; absoluteMs: number },
  ) {}

  async create(tx: Db, userId: string): Promise<{ token: string; sessionId: string }> {
    const token = randomBytes(32).toString('base64url');
    const now = this.opts.now();
    const [row] = await tx
      .insert(authSessions)
      .values({
        userId,
        tokenHash: hash(token),
        lastSeenAt: new Date(now),
        expiresAt: new Date(now + this.opts.absoluteMs),
      })
      .returning({ id: authSessions.id });
    if (!row) throw new Error('session insert failed');
    return { token, sessionId: row.id };
  }

  async resolve(token: string | undefined): Promise<{ sessionId: string; userId: string } | null> {
    if (!token || token.length > 128) return null;
    const [row] = await this.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.tokenHash, hash(token)));
    if (!row) return null;
    const now = this.opts.now();
    if (row.expiresAt.getTime() <= now || row.lastSeenAt.getTime() + this.opts.idleMs <= now) {
      await this.revoke(row.id);
      return null;
    }
    if (now - row.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      await this.db
        .update(authSessions)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(authSessions.id, row.id));
    }
    return { sessionId: row.id, userId: row.userId };
  }

  async revoke(sessionId: string, tx: Db = this.db): Promise<void> {
    await tx.delete(authSessions).where(eq(authSessions.id, sessionId));
  }

  async revokeAllForUser(tx: Db, userId: string, exceptSessionId?: string): Promise<void> {
    await tx
      .delete(authSessions)
      .where(
        exceptSessionId
          ? and(eq(authSessions.userId, userId), ne(authSessions.id, exceptSessionId))
          : eq(authSessions.userId, userId),
      );
  }
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readSessionCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eqAt = part.indexOf('=');
    if (eqAt > 0 && part.slice(0, eqAt).trim() === SESSION_COOKIE) return part.slice(eqAt + 1).trim();
  }
  return undefined;
}
