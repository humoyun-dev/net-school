import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.ts';
import { devices, meshBindings, sites } from '../../src/db/schema.ts';
import { makeDeviceKey, seedDevice } from './device.ts';
import type { FakeMesh } from './mesh.ts';

// Site'ni MeshCentral domain'iga bog'laydi (har site uchun alohida domain — FakeMesh scope bo'yicha ajratadi).
export async function setSiteDomain(db: Db, siteId: string, meshDomainId: string): Promise<void> {
  await db.update(sites).set({ meshDomainId }).where(eq(sites.id, siteId));
}

// Bog'langan qurilma: FakeMesh'da node (online), mesh_bindings qatori.
export async function seedBoundDevice(
  db: Db,
  mesh: FakeMesh,
  opts: {
    orgId: string;
    siteId: string;
    roomId?: string;
    domain: string;
    boundBy: string;
    online?: boolean;
    hostname?: string;
  },
): Promise<{ deviceId: string; nodeId: string }> {
  const deviceId = await seedDevice(db, opts.orgId, opts.siteId, makeDeviceKey().publicKey, {
    roomId: opts.roomId,
    hostname: opts.hostname,
  });
  const nodeId = `node-${deviceId.slice(0, 8)}`;
  mesh.nodes.set(nodeId, { domain: opts.domain, name: nodeId, online: opts.online ?? true });
  await db.insert(meshBindings).values({
    deviceId,
    organizationId: opts.orgId,
    siteId: opts.siteId,
    meshInstanceId: 'local',
    meshDomainId: opts.domain,
    meshNodeId: nodeId,
    boundBy: opts.boundBy,
  });
  return { deviceId, nodeId };
}

export async function retireDevice(db: Db, deviceId: string): Promise<void> {
  await db.update(devices).set({ retiredAt: new Date() }).where(eq(devices.id, deviceId));
}
