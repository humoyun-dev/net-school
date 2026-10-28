import type {
  DeviceBinding,
  DeviceEvent,
  DeviceManagementPort,
  DeviceSnapshot,
  EnrollmentResult,
  Unsubscribe,
} from '@netschool/domain';
import type { MeshRequester } from './control-client.ts';
import { AdapterError } from './errors.ts';
import { parseDeviceEvent } from './map-events.ts';
import { mapNodesResponse } from './map-nodes.ts';
import type { SiteMeshScope } from './node-id.ts';

// Bitta MeshCentral instance ustidagi inventory va eventlar. sites: siteId → shu instance'dagi domain.
export class MeshCentralDeviceManagement implements DeviceManagementPort {
  readonly #client: MeshRequester;
  readonly #sites: ReadonlyMap<string, SiteMeshScope>;

  constructor(client: MeshRequester, sites: ReadonlyMap<string, SiteMeshScope>) {
    this.#client = client;
    this.#sites = sites;
  }

  async listDevices(siteId: string): Promise<DeviceSnapshot[]> {
    const scope = this.#sites.get(siteId);
    if (!scope) throw new AdapterError('scope_denied', `Unknown site: ${siteId}`);
    return mapNodesResponse(await this.#client.request('nodes'), scope);
  }

  async reconcileEnrollment(binding: DeviceBinding): Promise<EnrollmentResult> {
    const scope = this.#sites.get(binding.siteId);
    const { upstream } = binding;
    if (!scope || scope.meshInstanceId !== upstream.meshInstanceId || scope.meshDomainId !== upstream.meshDomainId) {
      throw new AdapterError('scope_denied', 'Node is outside the site scope');
    }
    const snapshot = (await this.listDevices(binding.siteId)).find(
      (d) => d.upstream.meshNodeId === upstream.meshNodeId,
    );
    return snapshot ? { status: 'bound', snapshot } : { status: 'node_not_found' };
  }

  subscribeDeviceEvents(handler: (event: DeviceEvent) => void): Unsubscribe {
    const scopes = uniqueScopes(this.#sites);
    const offMessage = this.#client.onMessage((msg) => {
      for (const scope of scopes) {
        const event = parseDeviceEvent(msg, scope);
        if (event) handler(event);
      }
    });
    const offResync = this.#client.onResync(() => handler({ type: 'resync' }));
    return () => {
      offMessage();
      offResync();
    };
  }
}

function uniqueScopes(sites: ReadonlyMap<string, SiteMeshScope>): SiteMeshScope[] {
  const byKey = new Map<string, SiteMeshScope>();
  for (const scope of sites.values()) byKey.set(`${scope.meshInstanceId}\u0000${scope.meshDomainId}`, scope);
  return [...byKey.values()];
}
