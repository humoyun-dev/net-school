import { Inject, Injectable } from '@nestjs/common';
import type { CapabilityReport } from '@netschool/contracts';
import { HEARTBEAT_INTERVAL_MS } from '@netschool/domain';
import { and, eq, isNull } from 'drizzle-orm';
import { canonical } from '../../common/canonical-json.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { DB, type Db } from '../../db/client.ts';
import { deviceCapabilities, devices, lessonDevices, lessons } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import type { AuthenticatedDevice } from './device-auth.guard.ts';

// O'zgargan capability kalitlari va yuqori darajadagi maydonlar (os, desktopSession, …).
function changedKeys(before: CapabilityReport | null, after: CapabilityReport): string[] {
  const changed = new Set<string>();
  const top = ['protocolVersion', 'os', 'architecture', 'desktopSession'] as const;
  for (const field of top) if (canonical(before?.[field]) !== canonical(after[field])) changed.add(field);
  const caps = new Set([...Object.keys(before?.capabilities ?? {}), ...Object.keys(after.capabilities)]);
  for (const name of caps) {
    if (canonical(before?.capabilities[name]) !== canonical(after.capabilities[name])) changed.add(name);
  }
  return [...changed].sort();
}

export const OVERLAY_LEASE_MS = 120_000;

@Injectable()
export class PresenceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  // Javob qurilmaning faol darsini va overlay lease'ini beradi: lease yangilanmasa overlay o'zi tushadi (spec §10).
  async heartbeat(device: AuthenticatedDevice) {
    const now = this.now();
    await this.db
      .update(devices)
      .set({ lastHeartbeatAt: new Date(now) })
      .where(eq(devices.id, device.id));
    const [joined] = await this.db
      .select({ lessonId: lessonDevices.lessonId, locked: lessonDevices.overlayLocked, seq: lessonDevices.overlaySeq })
      .from(lessonDevices)
      .innerJoin(lessons, eq(lessons.id, lessonDevices.lessonId))
      .where(
        and(eq(lessonDevices.deviceId, device.id), isNull(lessonDevices.releasedAt), eq(lessons.status, 'active')),
      );
    return {
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_MS / 1000,
      lesson: joined
        ? {
            id: joined.lessonId,
            overlay: {
              locked: joined.locked,
              sequence: joined.seq === null ? null : String(joined.seq),
              leaseExpiresAt: new Date(now + OVERLAY_LEASE_MS).toISOString(),
              // Qurilma lease'ni monoton taymer bilan hisoblaydi; absolyut vaqt faqat ma'lumot uchun (spec §10).
              leaseSeconds: OVERLAY_LEASE_MS / 1000,
            },
          }
        : null,
    };
  }

  // Har hisobot saqlanadi; audit faqat haqiqiy o'zgarishda (heartbeat shovqini yo'q).
  async reportCapabilities(device: AuthenticatedDevice, report: CapabilityReport, correlationId: string) {
    const reportedAt = new Date(this.now());
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(deviceCapabilities)
        .where(eq(deviceCapabilities.deviceId, device.id))
        .for('update');
      const changed = changedKeys((existing?.report as CapabilityReport | undefined) ?? null, report);
      if (existing && changed.length === 0) {
        await tx.update(deviceCapabilities).set({ reportedAt }).where(eq(deviceCapabilities.deviceId, device.id));
        return;
      }
      await tx
        .insert(deviceCapabilities)
        .values({ deviceId: device.id, organizationId: device.organizationId, report, reportedAt })
        .onConflictDoUpdate({ target: deviceCapabilities.deviceId, set: { report, reportedAt } });
      await this.audit.write(
        tx,
        {
          organizationId: device.organizationId,
          siteId: device.siteId,
          actorUserId: null,
          action: 'device.capabilities_changed',
          targetType: 'device',
          targetId: device.id,
          result: 'succeeded',
          details: { changed },
        },
        correlationId,
      );
    });
  }
}
