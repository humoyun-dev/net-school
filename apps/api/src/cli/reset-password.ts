import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { authSessions, users } from '../db/schema.ts';
import { AuditWriter } from '../modules/audit/audit.writer.ts';
import { hashPassword } from '../modules/identity/password.ts';
import { oneTimePassword } from './bootstrap.ts';
import type { CliEnv, ExitCode } from './types.ts';

// Oflayn tiklash: yangi bir martalik parol, qulf yechiladi, o'chirilgan hisob qayta yoqiladi, barcha sessiyalar bekor.
export async function resetPassword(argv: string[], env: CliEnv): Promise<ExitCode> {
  const username = argv[0];
  if (!username || argv.length !== 1) {
    env.stdout.write('usage: netschool-admin reset-password <username>\n');
    return 1;
  }
  const password = oneTimePassword();
  const passwordHash = await hashPassword(password);
  const found = await env.db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, disabledAt: null })
      .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
      .returning();
    if (!user) return false;
    await tx.delete(authSessions).where(eq(authSessions.userId, user.id));
    await new AuditWriter().write(
      tx,
      {
        organizationId: user.organizationId,
        actorUserId: null,
        action: 'auth.password_reset',
        targetType: 'user',
        targetId: user.id,
        result: 'succeeded',
        details: { via: 'cli' },
      },
      randomUUID(),
    );
    return true;
  });
  if (!found) {
    env.stdout.write(`no such user: ${username}\n`);
    return 1;
  }
  env.stdout.write(`password: ${password}\n(parol faqat shu yerda ko'rsatiladi; birinchi kirishda almashtiriladi)\n`);
  return 0;
}
