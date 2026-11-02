import { createHash, createPublicKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium } from 'playwright';
import { lessons, meshBindings } from '../../api/src/db/schema.ts';
import { startTestApp, type TestApp } from '../../api/test/support/app.ts';
import { setCapabilities, setHeartbeat } from '../../api/test/support/caps.ts';
import { type DeviceKey, deviceRequest, makeDeviceKey, seedDevice } from '../../api/test/support/device.ts';
import { FakeMesh } from '../../api/test/support/mesh.ts';
import { setSiteDomain } from '../../api/test/support/power.ts';
import { seedOrg, seedRoom, seedUser } from '../../api/test/support/seed.ts';

export const DIST = join(import.meta.dirname, '..', 'dist');

export interface SeededDevice {
  id: string;
  key: DeviceKey;
  hostname: string;
  nodeId: string;
}

export interface World {
  app: TestApp;
  mesh: FakeMesh;
  browser: Browser;
  orgId: string;
  roomId: string;
  devices: SeededDevice[];
  activeLessonId(): Promise<string>;
  heartbeat(): Promise<void>;
  // Qurilmalar buyruqlarni oladi va `succeeded` receipt yuboradi (Companion o'rnida).
  ackAll(): Promise<number>;
  close(): Promise<void>;
}

// Chromium faqat test sertifikatining public key'iga ishonadi (TLS tekshiruvi o'chirilmaydi).
function spki(certPem: string): string {
  const der = createPublicKey(certPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

export async function startWorld(): Promise<World> {
  if (!existsSync(join(DIST, 'index.html')))
    throw new Error("apps/web/dist yo'q: avval `pnpm --filter @netschool/web build`");
  const mesh = new FakeMesh();
  const app = await startTestApp({
    webDistDir: DIST,
    deviceManagement: mesh.factory,
    mesh: { connected: true },
    workers: true,
  });
  const { orgId, siteId } = await seedOrg(app.db.db);
  await setSiteDomain(app.db.db, siteId, '');
  const roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  const adminId = await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId: null }]);
  await seedUser(app.db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }], { roomIds: [roomId] });
  const devices: SeededDevice[] = [];
  for (const hostname of ['pc-01', 'pc-02']) {
    const key = makeDeviceKey();
    const id = await seedDevice(app.db.db, orgId, siteId, key.publicKey, { roomId, hostname });
    await setCapabilities(app.db.db, orgId, id, {
      'classroom.message': { state: 'available' },
      'classroom.overlay': { state: 'available' },
      'classroom.thumbnails': { state: 'available' },
    });
    const nodeId = `node-${hostname}`;
    mesh.nodes.set(nodeId, { domain: '', name: hostname, online: true });
    await app.db.db.insert(meshBindings).values({
      deviceId: id,
      organizationId: orgId,
      siteId,
      meshInstanceId: 'local',
      meshDomainId: '',
      meshNodeId: nodeId,
      boundBy: adminId,
    });
    devices.push({ id, key, hostname, nodeId });
  }
  const heartbeat = async () => {
    for (const d of devices) await setHeartbeat(app.db.db, d.id, Date.now());
  };
  await heartbeat();
  const browser = await chromium.launch({
    headless: true,
    args: [`--ignore-certificate-errors-spki-list=${spki(app.ca)}`],
  });
  return {
    app,
    mesh,
    browser,
    orgId,
    roomId,
    devices,
    heartbeat,
    async activeLessonId() {
      const row = (await app.db.db.select().from(lessons)).find((l) => l.status === 'active');
      if (!row) throw new Error('no active lesson');
      return row.id;
    },
    async ackAll() {
      let n = 0;
      for (const d of devices) {
        const res = await deviceRequest(app, d.key, d.id, 'GET', '/api/v1/device/commands?wait=0');
        for (const c of (res.json?.commands ?? []) as { commandId: string }[]) {
          const path = `/api/v1/device/commands/${c.commandId}/receipt`;
          await deviceRequest(app, d.key, d.id, 'POST', path, { status: 'acknowledged' });
          await deviceRequest(app, d.key, d.id, 'POST', path, { status: 'succeeded' });
          n += 1;
        }
      }
      return n;
    },
    async close() {
      await browser.close().catch(() => {});
      await app.close();
    },
  };
}
