import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
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
      await this.#failed(this.db, user ?? null, user ? 'disabled' : 'bad_credentials', correlationId);
      throw new ApiError('unauthenticated');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > now) {
      await verifyPassword(password, DUMMY_HASH);
      await this.#failed(this.db, user, 'locked', correlationId);
      throw new ApiError('unauthenticated');
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.db.transaction(async (tx) => {
        const lockedNow = await this.#countFailure(tx, user.id, now);
        await this.#failed(tx, user, 'bad_credentials', correlationId);
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

    return this.db.transaction(async (tx) => {
      await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
      const session = await this.sessions.create(tx, user.id);
      await this.audit.write(
        tx,
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'auth.login',
          targetType: 'user',
          targetId: user.id,
          result: 'succeeded',
        },
        correlationId,
      );
      return { token: session.token, user: userSummary(user) };
    });
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

  async changePassword(user: UserRow, sessionId: string, current: string, next: string, correlationId: string) {
    if (!(await verifyPassword(current, user.passwordHash))) throw new ApiError('unauthenticated');
    const passwordHash = await hashPassword(next);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, user.id));
      await this.sessions.revokeAllForUser(tx, user.id, sessionId);
      await this.audit.write(
        tx,
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'auth.password_changed',
          targetType: 'user',
          targetId: user.id,
          result: 'succeeded',
        },
        correlationId,
      );
    });
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

  #failed(tx: Db, user: UserRow | null, reason: 'bad_credentials' | 'locked' | 'disabled', correlationId: string) {
    return this.audit.write(
      tx,
      {
        organizationId: user?.organizationId ?? null,
        actorUserId: null,
        action: 'auth.login',
        targetType: user ? 'user' : undefined,
        targetId: user?.id,
        result: 'failed',
        details: { reason },
      },
      correlationId,
    );
  }
}
