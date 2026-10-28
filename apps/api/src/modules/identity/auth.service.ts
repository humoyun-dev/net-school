import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { ApiError } from '../../common/errors.ts';
import { DB, type Db } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { type UserRow, userSummary } from './actor.loader.ts';
import type { LoginThrottle } from './login-throttle.ts';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.ts';
import { SessionService } from './sessions.ts';

export const LOCK_THRESHOLD = 10;
export const LOCK_MS = 15 * 60 * 1000;
export const LOGIN_THROTTLE = Symbol('LOGIN_THROTTLE');

type FailureReason = 'bad_credentials' | 'locked' | 'disabled';
// Parol tekshiruvi bo'ladigan ikki joy; ikkalasi bir xil qulf hisoblagichini ishlatadi.
type CredentialCheck = 'auth.login' | 'auth.password_changed';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(LOGIN_THROTTLE) private readonly throttle: LoginThrottle,
  ) {}

  async login(username: string, password: string, ip: string, correlationId: string) {
    if (!this.throttle.hit(ip)) throw new ApiError('rate_limited');
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.username})`, username.toLowerCase()));
    const now = this.now();

    if (!user || user.disabledAt) {
      await verifyPassword(password, DUMMY_HASH);
      await this.#failed(this.db, 'auth.login', user ?? null, user ? 'disabled' : 'bad_credentials', correlationId);
      throw new ApiError('unauthenticated');
    }
    await this.#verify('auth.login', user, password, now, correlationId);

    const result = await this.db.transaction(async (tx) => {
      // scrypt davomida boshqa urinish hisobni qulflagan bo'lsa, muvaffaqiyat qulfni yecha olmaydi.
      if (!(await this.#clearFailures(tx, user.id, now))) return null;
      const session = await this.sessions.create(tx, user.id);
      await this.#succeeded(tx, 'auth.login', user, correlationId);
      return { token: session.token, user: userSummary(user) };
    });
    if (!result) return this.#reject(this.db, 'auth.login', user, 'locked', correlationId);
    return result;
  }

  async logout(user: UserRow, sessionId: string, correlationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.sessions.revoke(sessionId, tx);
      await this.audit.write(
        tx,
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'auth.logout',
          targetType: 'session',
          targetId: sessionId,
          result: 'succeeded',
        },
        correlationId,
      );
    });
  }

  // Joriy parol login bilan bir xil qulf hisoblagichidan o'tadi: ochiq sessiyadan parolni taxmin qilib bo'lmaydi.
  async changePassword(user: UserRow, sessionId: string, current: string, next: string, correlationId: string) {
    const now = this.now();
    await this.#verify('auth.password_changed', user, current, now, correlationId);
    const passwordHash = await hashPassword(next);
    const changed = await this.db.transaction(async (tx) => {
      if (!(await this.#clearFailures(tx, user.id, now))) return false;
      await tx.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, user.id));
      await this.sessions.revokeAllForUser(tx, user.id, sessionId);
      await this.#succeeded(tx, 'auth.password_changed', user, correlationId);
      return true;
    });
    if (!changed) await this.#reject(this.db, 'auth.password_changed', user, 'locked', correlationId);
  }

  // Qulf va parolni tekshiradi; xato bo'lsa hisoblaydi, audit qiladi va 401 otadi.
  async #verify(check: CredentialCheck, user: UserRow, password: string, now: number, correlationId: string) {
    if (user.lockedUntil && user.lockedUntil.getTime() > now) {
      await verifyPassword(password, DUMMY_HASH);
      await this.#reject(this.db, check, user, 'locked', correlationId);
    }
    if (await verifyPassword(password, user.passwordHash)) return;
    await this.db.transaction(async (tx) => {
      const lockedNow = await this.#countFailure(tx, user.id, now);
      await this.#failed(tx, check, user, 'bad_credentials', correlationId);
      if (lockedNow) {
        await this.audit.write(
          tx,
          {
            organizationId: user.organizationId,
            actorUserId: null,
            action: 'auth.lockout',
            targetType: 'user',
            targetId: user.id,
            result: 'succeeded',
          },
          correlationId,
        );
      }
    });
    throw new ApiError('unauthenticated');
  }

  // Atomik hisoblagich: qulf aniq 10-xatoda bir marta qo'yiladi; eskirgan qulf yangi hisob boshlaydi.
  async #countFailure(tx: Db, userId: string, now: number): Promise<boolean> {
    const at = new Date(now).toISOString();
    const until = new Date(now + LOCK_MS).toISOString();
    const expired = sql`${users.lockedUntil} is not null and ${users.lockedUntil} <= ${at}::timestamptz`;
    const [row] = await tx
      .update(users)
      .set({
        failedLoginCount: sql`case when ${expired} then 1 else ${users.failedLoginCount} + 1 end`,
        lockedUntil: sql`case when ${expired} then null when ${users.failedLoginCount} + 1 = ${LOCK_THRESHOLD} then ${until}::timestamptz else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, userId))
      .returning({ count: users.failedLoginCount, lockedUntil: users.lockedUntil });
    return row?.count === LOCK_THRESHOLD && row.lockedUntil !== null;
  }

  // Faqat qulf yo'q (yoki muddati o'tgan) va hisob faol bo'lsa nolga tushiradi; aks holda false.
  async #clearFailures(tx: Db, userId: string, now: number): Promise<boolean> {
    const rows = await tx
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(
        and(
          eq(users.id, userId),
          isNull(users.disabledAt),
          or(isNull(users.lockedUntil), lte(users.lockedUntil, new Date(now))),
        ),
      )
      .returning({ id: users.id });
    return rows.length === 1;
  }

  async #reject(
    tx: Db,
    check: CredentialCheck,
    user: UserRow,
    reason: FailureReason,
    correlationId: string,
  ): Promise<never> {
    await this.#failed(tx, check, user, reason, correlationId);
    throw new ApiError('unauthenticated');
  }

  #succeeded(tx: Db, check: CredentialCheck, user: UserRow, correlationId: string) {
    return this.audit.write(
      tx,
      {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: check,
        targetType: 'user',
        targetId: user.id,
        result: 'succeeded',
      },
      correlationId,
    );
  }

  #failed(tx: Db, check: CredentialCheck, user: UserRow | null, reason: FailureReason, correlationId: string) {
    return this.audit.write(
      tx,
      {
        organizationId: user?.organizationId ?? null,
        actorUserId: check === 'auth.login' ? null : (user?.id ?? null),
        action: check,
        targetType: user ? 'user' : undefined,
        targetId: user?.id,
        result: 'failed',
        details: { reason },
      },
      correlationId,
    );
  }
}
