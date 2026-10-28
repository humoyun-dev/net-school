import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.ts';
import { deviceCapabilities, devices } from '../../src/db/schema.ts';

export async function setCapabilities(
  db: Db,
  orgId: string,
  deviceId: string,
  capabilities: Record<string, { state: string }>,
): Promise<void> {
  const report = { protocolVersion: 1, os: 'linux', architecture: 'x64', desktopSession: 'x11', capabilities };
  await db
    .insert(deviceCapabilities)
    .values({ deviceId, organizationId: orgId, report, reportedAt: new Date() })
    .onConflictDoUpdate({ target: deviceCapabilities.deviceId, set: { report } });
}

export async function setHeartbeat(db: Db, deviceId: string, at: number | null): Promise<void> {
  await db
    .update(devices)
    .set({ lastHeartbeatAt: at === null ? null : new Date(at) })
    .where(eq(devices.id, deviceId));
}
