import { MeshCentralDeviceManagement, MeshControlClient } from '@netschool/meshcentral-adapter';
import { createApp } from './app.ts';
import { loadConfig } from './config/config.ts';
import { connectPg } from './db/client.ts';
import { keepConnected } from './modules/devices/mesh.ts';
import { buildRemoteUpstream, RemoteGateway } from './modules/remote-sessions/remote-gateway.ts';

const config = loadConfig(process.env);
const pg = connectPg(config.databaseUrl);
// MeshCentral ixtiyoriy: berilmasa binding endpointlari 409 capability_unavailable qaytaradi, gateway ishga tushmaydi.
const mesh = config.mesh ? new MeshControlClient({ ...config.mesh, requestTimeoutMs: 3_000 }) : null;
const remote = mesh ? buildRemoteUpstream(mesh, config) : null;
const app = await createApp(config, {
  db: pg.db,
  deviceManagement: mesh ? (scopes) => new MeshCentralDeviceManagement(mesh, scopes) : null,
  remote,
  mesh,
  workers: true,
});
app.enableShutdownHooks();
const stopMesh = mesh ? keepConnected(mesh) : () => {};
await app.listen(config.port, config.host);
const gateway = app.get(RemoteGateway);
if (gateway.enabled && config.gateway) await gateway.listen(config.gateway.port, config.host);
process.once('beforeExit', () => {
  stopMesh();
  void mesh?.close();
  void pg.close();
});
