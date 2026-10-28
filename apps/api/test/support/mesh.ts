import type { DeviceManagementPort, DeviceSnapshot } from '@netschool/domain';
import type { DeviceManagementFactory, SiteScope } from '../../src/modules/devices/mesh.ts';

export interface FakeNode {
  domain: string;
  name: string;
  online: boolean;
}

// MeshCentral o'rnida: site scope'i bo'yicha node'lar; `failing` — upstream uzilgan.
export class FakeMesh {
  readonly nodes = new Map<string, FakeNode>();
  failing = false;

  readonly factory: DeviceManagementFactory = (scopes) => this.#port(scopes);

  #port(scopes: ReadonlyMap<string, SiteScope>): DeviceManagementPort {
    const list = async (siteId: string): Promise<DeviceSnapshot[]> => {
      if (this.failing) throw new Error('upstream down');
      const scope = scopes.get(siteId);
      if (!scope) throw new Error(`no scope for ${siteId}`);
      return [...this.nodes]
        .filter(([, n]) => n.domain === scope.meshDomainId)
        .map(([id, n]) => ({
          upstream: { meshInstanceId: scope.meshInstanceId, meshDomainId: n.domain, meshNodeId: id },
          name: n.name,
          hostname: `${n.name}.lan`,
          osDescription: 'Linux',
          agentOnline: n.online,
          powerState: n.online ? 'on' : 'unknown',
        }));
    };
    return {
      listDevices: list,
      async reconcileEnrollment(binding) {
        const scope = scopes.get(binding.siteId);
        if (!scope || scope.meshDomainId !== binding.upstream.meshDomainId) throw new Error('scope_denied');
        const snapshot = (await list(binding.siteId)).find(
          (d) => d.upstream.meshNodeId === binding.upstream.meshNodeId,
        );
        return snapshot ? { status: 'bound', snapshot } : { status: 'node_not_found' };
      },
      subscribeDeviceEvents: () => () => {},
    };
  }
}
