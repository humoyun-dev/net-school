import { MeshCentralDeviceManagement, MeshControlClient } from '@netschool/meshcentral-adapter';
import { createApp } from './app.ts';
import { loadConfig } from './config/config.ts';
import { connectPg } from './db/client.ts';
import { keepConnected } from './modules/devices/mesh.ts';

const config = loadConfig(process.env);
const pg = connectPg(config.databaseUrl);
// MeshCentral ixtiyoriy: berilmasa binding endpointlari 409 capability_unavailable qaytaradi.
const mesh = config.mesh ? new MeshControlClient({ ...config.mesh, requestTimeoutMs: 3_000 }) : null;
const app = await createApp(config, {
  db: pg.db,
  deviceManagement: mesh ? (scopes) => new MeshCentralDeviceManagement(mesh, scopes) : null,
});
app.enableShutdownHooks();
const stopMesh = mesh ? keepConnected(mesh) : () => {};
await app.listen(config.port, config.host);
process.once('beforeExit', () => {
  stopMesh();
  void mesh?.close();
  void pg.close();
});
