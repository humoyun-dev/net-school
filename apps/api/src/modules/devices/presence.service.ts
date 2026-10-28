import { Inject, Injectable } from '@nestjs/common';
import type { CapabilityReport } from '@netschool/contracts';
import { HEARTBEAT_INTERVAL_MS } from '@netschool/domain';
import { eq } from 'drizzle-orm';
import { canonical } from '../../common/canonical-json.ts';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { DB, type Db } from '../../db/client.ts';
import { deviceCapabilities, devices } from '../../db/schema.ts';
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

@Injectable()
export class PresenceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  async heartbeat(device: AuthenticatedDevice) {
    await this.db
      .update(devices)
      .set({ lastHeartbeatAt: new Date(this.now()) })
      .where(eq(devices.id, device.id));
    return { heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_MS / 1000 };
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
