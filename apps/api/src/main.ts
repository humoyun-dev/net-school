import {
  MeshCentralDeviceManagement,
  MeshCentralPrincipals,
  MeshCentralViewerUpstream,
  MeshControlClient,
} from '@netschool/meshcentral-adapter';
import { createApp } from './app.ts';
import { loadConfig, meshHttpsOrigin } from './config/config.ts';
import { connectPg } from './db/client.ts';
import { keepConnected } from './modules/devices/mesh.ts';
import { RemoteGateway, type RemoteUpstream } from './modules/remote-sessions/remote-gateway.ts';

const config = loadConfig(process.env);
const pg = connectPg(config.databaseUrl);
// MeshCentral ixtiyoriy: berilmasa binding endpointlari 409 capability_unavailable qaytaradi, gateway ishga tushmaydi.
const mesh = config.mesh ? new MeshControlClient({ ...config.mesh, requestTimeoutMs: 3_000 }) : null;
let remote: RemoteUpstream | null = null;
if (mesh && config.mesh && config.gateway) {
  const principals = new MeshCentralPrincipals(mesh);
  remote = {
    viewer: new MeshCentralViewerUpstream({
      admin: mesh,
      endpoint: { origin: meshHttpsOrigin(config.mesh), ca: config.mesh.ca },
      // Viewer sahifasidagi host'lar brauzer ko'radigan gateway host'iga almashtiriladi.
      publicHost: new URL(config.gateway.publicOrigin).host,
    }),
    listPrincipals: () => principals.listSessionPrincipals(),
    revokePrincipal: (userId) => principals.revoke(userId),
  };
}
const app = await createApp(config, {
  db: pg.db,
  deviceManagement: mesh ? (scopes) => new MeshCentralDeviceManagement(mesh, scopes) : null,
  remote,
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
