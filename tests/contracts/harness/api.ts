import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { DeviceManagementPort } from '@netschool/domain';
import {
  MeshCentralDeviceManagement,
  MeshCentralPrincipals,
  MeshControlClient,
  type SiteMeshScope,
} from '@netschool/meshcentral-adapter';
import { makeCert, type TestCert } from '@netschool/test-support';
import { createApp } from '../../../apps/api/src/app.ts';
import type { ApiConfig } from '../../../apps/api/src/config/config.ts';
import { organizations, roomMemberships, sites } from '../../../apps/api/src/db/schema.ts';
import { keepConnected } from '../../../apps/api/src/modules/devices/mesh.ts';
import { buildRemoteUpstream, RemoteGateway } from '../../../apps/api/src/modules/remote-sessions/remote-gateway.ts';
import { createTestDb, type TestDb } from '../../../apps/api/test/support/db.ts';
import { makeDeviceKey, seedDevice } from '../../../apps/api/test/support/device.ts';
import { seedBinding } from '../../../apps/api/test/support/remote.ts';
import { cookieFrom, PASSWORD, seedRoom, seedUser } from '../../../apps/api/test/support/seed.ts';
import { Browser } from './gateway.ts';
import { freePort, type MeshCentralInstance } from './meshcentral.ts';

const MESH_INSTANCE_ID = 'local';
// Test MeshCentral'i default domain'da: site va binding'lar '' domain bilan.
const MESH_DOMAIN_ID = '';

export const newKey = () => `k-${randomUUID()}`;

export interface ApiReply {
  status: number;
  headers: IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: contract testlarida javoblarni erkin o'qish uchun
  json: any;
}

export interface SeededLesson {
  lessonId: string;
  roomId: string;
  deviceId: string;
  meshNodeId: string;
}

export interface ApiInstance {
  baseUrl: string;
  gatewayOrigin: string;
  ca: string; // API va gateway TLS sertifikati (brauzer o'rni shu CA'ga ishonadi)
  db: TestDb;
  request(method: string, path: string, init?: { cookie?: string; body?: unknown; key?: string }): Promise<ApiReply>;
  login(username: 'teacher1' | 'admin1'): Promise<string>;
  // Yangi xona, unda bog'langan qurilma (MeshCentral'da agentsiz node) va teacher1 boshlagan dars.
  seedLessonWithBoundDevice(): Promise<SeededLesson>;
  browser(): Browser;
  // MeshCentral'dagi `ns-sess-*` principal'larning sessiya id'lari (API'dan mustaqil admin ulanishi orqali).
  principalSessionIds(): Promise<string[]>;
  // Yiqilish o'rnida: app revoke qilmasdan yopiladi, `whileDown` bajariladi, keyin shu DB, MeshCentral va portlar
  // bilan yangi app ishga tushadi (reconciliation'ning DB qismi app.listen ichida tugaydi).
  restart(whileDown?: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

interface Running {
  app: Awaited<ReturnType<typeof createApp>>;
  mesh: MeshControlClient;
  stopMesh: () => void;
}

// Production ulanishi (apps/api/src/main.ts) bilan bir xil: createApp → keepConnected → app.listen → gateway.listen.
// Yagona farq: real agent yo'q, shuning uchun seed qilingan node'lar `agentOnline: true` ko'rsatiladi.
export async function startApi(mc: MeshCentralInstance): Promise<ApiInstance> {
  const tls: TestCert = await makeCert('localhost');
  const port = await freePort();
  const gatewayPort = await freePort();
  const baseUrl = `https://localhost:${port}`;
  const gatewayOrigin = `https://localhost:${gatewayPort}`;
  const meshConnection = { url: mc.url, username: mc.admin.username, password: mc.admin.password, ca: mc.ca };
  const config: ApiConfig = {
    port,
    host: '127.0.0.1',
    publicOrigin: baseUrl,
    tls,
    databaseUrl: 'unused',
    mesh: meshConnection,
    meshInstanceId: MESH_INSTANCE_ID,
    gateway: { port: gatewayPort, publicOrigin: gatewayOrigin },
  };
  const scope: SiteMeshScope = { meshInstanceId: MESH_INSTANCE_ID, meshDomainId: MESH_DOMAIN_ID };

  // Seed va tekshiruv uchun alohida admin ulanishi (API jarayoniga tegishli emas).
  const admin = new MeshControlClient(meshConnection);
  await admin.connect();
  const meshid = (await admin.request<{ meshid: string }>('createmesh', { meshname: 'api-contract', meshtype: 3 }))
    .meshid;

  const db = await createTestDb();
  const [org] = await db.db.insert(organizations).values({ name: 'Maktab 1' }).returning();
  if (!org) throw new Error('seed org');
  const orgId = org.id;
  const [site] = await db.db
    .insert(sites)
    .values({ organizationId: orgId, name: 'Bino A', meshDomainId: MESH_DOMAIN_ID })
    .returning();
  if (!site) throw new Error('seed site');
  const siteId = site.id;
  const teacherId = await seedUser(db.db, orgId, 'teacher1', [{ role: 'teacher', siteId }]);
  const adminId = await seedUser(db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  const inventory = new MeshCentralDeviceManagement(admin, new Map([[siteId, scope]]));

  const online = new Set<string>();
  const withSeededAgents = (port: DeviceManagementPort): DeviceManagementPort => ({
    listDevices: async (id) =>
      (await port.listDevices(id)).map((d) =>
        online.has(d.upstream.meshNodeId) ? { ...d, agentOnline: true, powerState: 'on' } : d,
      ),
    reconcileEnrollment: (binding) => port.reconcileEnrollment(binding),
    subscribeDeviceEvents: (handler) => port.subscribeDeviceEvents(handler),
  });

  const launch = async (): Promise<Running> => {
    const mesh = new MeshControlClient({ ...meshConnection, requestTimeoutMs: 3_000 });
    const app = await createApp(config, {
      db: db.db,
      deviceManagement: (scopes) => withSeededAgents(new MeshCentralDeviceManagement(mesh, scopes)),
      remote: buildRemoteUpstream(mesh, config),
      workers: true,
      logger: false,
    });
    const stopMesh = keepConnected(mesh);
    await app.listen(port, config.host);
    const gateway = app.get(RemoteGateway);
    if (!gateway.enabled) throw new Error('remote gateway is not enabled');
    await gateway.listen(gatewayPort, config.host);
    return { app, mesh, stopMesh };
  };
  const halt = async ({ app, mesh, stopMesh }: Running) => {
    await app.close();
    stopMesh();
    await mesh.close();
  };
  let running = await launch();

  const request: ApiInstance['request'] = (method, path, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    // Brauzer kabi: o'zgartiruvchi so'rovlarda Origin.
    const headers: Record<string, string> = { origin: baseUrl };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (init.cookie) headers.cookie = init.cookie;
    if (init.key) headers['idempotency-key'] = init.key;
    return new Promise((resolve, reject) => {
      httpsRequest({ host: '127.0.0.1', port, servername: 'localhost', ca: tls.cert, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text ? JSON.parse(text) : undefined });
        });
        res.on('error', reject);
      })
        .on('error', reject)
        .end(body);
    });
  };

  const login = async (username: string): Promise<string> => {
    const res = await request('POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } });
    if (res.status !== 200) throw new Error(`login ${username}: ${res.status}`);
    return cookieFrom(res.headers['set-cookie']?.join(', ') ?? null);
  };

  let seq = 0;
  const principals = new MeshCentralPrincipals(admin);

  return {
    baseUrl,
    gatewayOrigin,
    ca: tls.cert,
    db,
    request,
    login,
    async seedLessonWithBoundDevice() {
      const n = ++seq;
      const roomId = await seedRoom(db.db, orgId, siteId, `room-${n}`);
      await db.db.insert(roomMemberships).values({ organizationId: orgId, roomId, userId: teacherId });
      const deviceId = await seedDevice(db.db, orgId, siteId, makeDeviceKey().publicKey, {
        roomId,
        hostname: `pc-${n}`,
      });
      const name = `pc-${n}`;
      await admin.request('addlocaldevice', { meshid, devicename: name, hostname: `${name}.lan`, type: 4 });
      const node = (await inventory.listDevices(siteId)).find((d) => d.name === name);
      if (!node) throw new Error(`${name} not found in MeshCentral`);
      const { meshNodeId } = node.upstream;
      await seedBinding(db.db, { orgId, siteId, deviceId, meshDomainId: MESH_DOMAIN_ID, meshNodeId, boundBy: adminId });
      online.add(meshNodeId);
      const teacher = await login('teacher1');
      const lesson = await request('POST', `/api/v1/rooms/${roomId}/lessons`, {
        cookie: teacher,
        body: {},
        key: newKey(),
      });
      if (lesson.status !== 201) throw new Error(`lesson start: ${lesson.status}`);
      return { lessonId: lesson.json.id, roomId, deviceId, meshNodeId };
    },
    browser: () => new Browser(gatewayPort, tls.cert),
    async principalSessionIds() {
      return (await principals.listSessionPrincipals()).map((p) => p.sessionId);
    },
    async restart(whileDown) {
      await halt(running);
      await whileDown?.();
      running = await launch();
    },
    async close() {
      await halt(running);
      await admin.close();
      await db.close();
    },
  };
}
