import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ClaimRequest, CreateEnrollmentRequest, Enrollment } from '@netschool/contracts';
import { HEARTBEAT_INTERVAL_MS } from '@netschool/domain';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { Access } from '../../common/access.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { isUniqueViolation, isUuid } from '../../common/db-errors.ts';
import { ApiError } from '../../common/errors.ts';
import type { RequestContext } from '../../common/request-context.ts';
import { DB, type Db } from '../../db/client.ts';
import { deviceCapabilities, devices, enrollments, rooms, sites } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import type { LoginThrottle } from '../identity/login-throttle.ts';
import { keyFingerprint, parseDevicePublicKey, verifyClaimProof } from './device-keys.ts';

export const CLAIM_THROTTLE = Symbol('CLAIM_THROTTLE');
const DEFAULT_TTL_MINUTES = 60;

type EnrollmentRow = typeof enrollments.$inferSelect;

const hashToken = (token: string) => createHash('sha256').update(token).digest();

@Injectable()
export class EnrollmentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(Access) private readonly access: Access,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(CLAIM_THROTTLE) private readonly throttle: LoginThrottle,
  ) {}

  async create(ctx: RequestContext, input: CreateEnrollmentRequest) {
    const actor = this.access.actor(ctx);
    const site = await this.#site(ctx, input.siteId);
    if (input.roomId !== undefined) {
      const [room] = await this.db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(eq(rooms.id, input.roomId), eq(rooms.siteId, site.id)));
      if (!room) return this.access.deny(ctx, 'device.enroll', { targetType: 'room', targetId: input.roomId }, site.id);
    }
    await this.access.require(
      ctx,
      'device.enroll',
      { organizationId: site.organizationId, siteId: site.id },
      { targetType: 'site', targetId: site.id },
    );
    const token = `nse_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(this.now() + (input.expiresInMinutes ?? DEFAULT_TTL_MINUTES) * 60_000);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(enrollments)
        .values({
          organizationId: site.organizationId,
          siteId: site.id,
          roomId: input.roomId ?? null,
          tokenHash: hashToken(token),
          createdBy: actor.userId,
          createdAt: new Date(this.now()),
          expiresAt,
        })
        .returning();
      if (!row) throw new Error('enrollment insert failed');
      await this.#ok(tx, ctx, 'enrollment.create', row, { roomId: row.roomId, expiresAt: expiresAt.toISOString() });
      return { ...this.#view(row), token };
    });
  }

  async list(ctx: RequestContext, siteId: string): Promise<Enrollment[]> {
    const site = await this.#site(ctx, siteId);
    await this.access.require(
      ctx,
      'device.enroll',
      { organizationId: site.organizationId, siteId: site.id },
      { targetType: 'site', targetId: site.id },
    );
    const rows = await this.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.siteId, site.id))
      .orderBy(desc(enrollments.createdAt))
      .limit(500);
    return rows.map((r) => this.#view(r));
  }

  async revoke(ctx: RequestContext, enrollmentId: string): Promise<void> {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(enrollmentId)
      ? await this.db
          .select()
          .from(enrollments)
          .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.organizationId, actor.organizationId)))
      : [];
    if (!row) return this.access.deny(ctx, 'device.enroll', { targetType: 'enrollment', targetId: enrollmentId });
    await this.access.require(
      ctx,
      'device.enroll',
      { organizationId: row.organizationId, siteId: row.siteId },
      { targetType: 'enrollment', targetId: row.id },
    );
    const now = new Date(this.now());
    await this.db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(enrollments)
        .set({ revokedAt: now })
        .where(
          and(
            eq(enrollments.id, row.id),
            isNull(enrollments.claimedAt),
            isNull(enrollments.revokedAt),
            gt(enrollments.expiresAt, now),
          ),
        )
        .returning();
      if (!revoked) throw new ApiError('conflict', 'Enrollment is not pending');
      await this.#ok(tx, ctx, 'enrollment.revoke', revoked);
    });
  }

  // Qurilma tomoni: token bir martalik, kalit egaligi proof bilan isbotlanadi.
  async claim(input: ClaimRequest, clientIp: string, correlationId: string) {
    if (!this.throttle.hit(clientIp)) throw new ApiError('rate_limited');
    const tokenHash = hashToken(input.token);
    const key = parseDevicePublicKey(input.publicKey);
    // Proof tokenni sarflashdan oldin tekshiriladi: noto'g'ri proof tokenni yoqmaydi.
    if (!key || !verifyClaimProof(key, input.token, input.publicKey, input.proof)) {
      return this.#claimFailed(tokenHash, 'invalid_proof', correlationId);
    }
    const der = Buffer.from(input.publicKey, 'base64url');
    const now = new Date(this.now());
    try {
      const result = await this.db.transaction(async (tx) => {
        const [enrollment] = await tx
          .update(enrollments)
          .set({ claimedAt: now })
          .where(
            and(
              eq(enrollments.tokenHash, tokenHash),
              isNull(enrollments.claimedAt),
              isNull(enrollments.revokedAt),
              gt(enrollments.expiresAt, now),
            ),
          )
          .returning();
        if (!enrollment) return null;
        const [device] = await tx
          .insert(devices)
          .values({
            organizationId: enrollment.organizationId,
            siteId: enrollment.siteId,
            roomId: enrollment.roomId,
            hostname: input.hostname,
            publicKey: der,
            keyFingerprint: keyFingerprint(der),
            enrolledAt: now,
          })
          .returning();
        if (!device) throw new Error('device insert failed');
        await tx.update(enrollments).set({ deviceId: device.id }).where(eq(enrollments.id, enrollment.id));
        await tx.insert(deviceCapabilities).values({
          deviceId: device.id,
          organizationId: device.organizationId,
          report: input.capabilities,
          reportedAt: now,
        });
        await this.audit.write(
          tx,
          {
            organizationId: device.organizationId,
            siteId: device.siteId,
            actorUserId: null,
            action: 'device.claim',
            targetType: 'device',
            targetId: device.id,
            result: 'succeeded',
            details: { enrollmentId: enrollment.id, hostname: device.hostname },
          },
          correlationId,
        );
        return { deviceId: device.id, siteId: device.siteId, heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_MS / 1000 };
      });
      return result ?? this.#claimFailed(tokenHash, 'invalid_token', correlationId);
    } catch (err) {
      // Kalit allaqachon boshqa qurilmada: tranzaksiya qaytdi, token sarflanmadi.
      if (isUniqueViolation(err)) throw new ApiError('conflict', 'Device key is already enrolled');
      throw err;
    }
  }

  async #claimFailed(tokenHash: Buffer, reason: 'invalid_token' | 'invalid_proof', correlationId: string) {
    const [known] = await this.db
      .select({ organizationId: enrollments.organizationId, siteId: enrollments.siteId, id: enrollments.id })
      .from(enrollments)
      .where(eq(enrollments.tokenHash, tokenHash));
    await this.audit.write(
      this.db,
      {
        organizationId: known?.organizationId ?? null,
        siteId: known?.siteId ?? null,
        actorUserId: null,
        action: 'device.claim',
        targetType: known ? 'enrollment' : undefined,
        targetId: known?.id,
        result: 'failed',
        details: { reason },
      },
      correlationId,
    );
    throw new ApiError('unauthenticated');
  }

  #view(row: EnrollmentRow): Enrollment {
    const now = this.now();
    const status = row.revokedAt
      ? 'revoked'
      : row.claimedAt
        ? 'claimed'
        : row.expiresAt.getTime() <= now
          ? 'expired'
          : 'pending';
    return {
      id: row.id,
      siteId: row.siteId,
      roomId: row.roomId,
      status,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      deviceId: row.deviceId,
    };
  }

  async #site(ctx: RequestContext, siteId: string) {
    const actor = this.access.actor(ctx);
    const [row] = isUuid(siteId)
      ? await this.db
          .select()
          .from(sites)
          .where(and(eq(sites.id, siteId), eq(sites.organizationId, actor.organizationId)))
      : [];
    return row ?? this.access.deny(ctx, 'device.enroll', { targetType: 'site', targetId: siteId });
  }

  #ok(tx: Db, ctx: RequestContext, action: string, row: EnrollmentRow, details?: Record<string, unknown>) {
    const actor = this.access.actor(ctx);
    return this.audit.write(
      tx,
      {
        organizationId: row.organizationId,
        siteId: row.siteId,
        actorUserId: actor.userId,
        action,
        targetType: 'enrollment',
        targetId: row.id,
        result: 'succeeded',
        details,
      },
      ctx.correlationId,
    );
  }
}
