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
  // Berilsa reconcileEnrollment shu va'da bajarilguncha kutadi (poyga testlari uchun).
  #held: { reached: () => void; gate: Promise<void> } | null = null;

  hold(): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.#held = { reached, gate };
    return { reached: reachedP, release };
  }

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
    const held = () => this.#held;
    return {
      listDevices: list,
      async reconcileEnrollment(binding) {
        const h = held();
        if (h) {
          h.reached();
          await h.gate;
        }
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
