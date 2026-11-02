import type {
  DeviceManagementPort,
  DeviceSnapshot,
  PowerActionType,
  PowerRequestResult,
  PowerState,
} from '@netschool/domain';
import { AdapterError } from '@netschool/meshcentral-adapter';
import type { DeviceManagementFactory, SiteScope } from '../../src/modules/devices/mesh.ts';

export interface FakeNode {
  domain: string;
  name: string;
  online: boolean;
  // Berilmasa online ? 'on' : 'unknown'.
  powerState?: PowerState;
}

// MeshCentral o'rnida: site scope'i bo'yicha node'lar; `failing` — upstream uzilgan.
export class FakeMesh {
  readonly nodes = new Map<string, FakeNode>();
  failing = false;
  // Faqat shu domain'lar uchun listDevices xato beradi (bitta site uzilgan).
  readonly failingDomains = new Set<string>();
  // listDevices chaqiruvlari soni (site bo'yicha).
  readonly listCalls = new Map<string, number>();
  // Quvvat so'rovlari (yuborilish tartibida); powerFailing — requestPowerAction javob bermaydi (timeout).
  readonly powerRequests: Array<{ siteId: string; nodeId: string; type: PowerActionType }> = [];
  readonly wakeResults = new Map<string, PowerRequestResult>();
  powerFailing = false;
  // Berilsa listDevices javobidan oldin bajariladi (agent holatini o'qish paytidagi poyga testlari uchun).
  beforeList: (() => Promise<void>) | null = null;
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
      await this.beforeList?.();
      if (this.failing) throw new Error('upstream down');
      this.listCalls.set(siteId, (this.listCalls.get(siteId) ?? 0) + 1);
      const scope = scopes.get(siteId);
      if (!scope) throw new Error(`no scope for ${siteId}`);
      if (this.failingDomains.has(scope.meshDomainId)) throw new Error('site upstream down');
      return [...this.nodes]
        .filter(([, n]) => n.domain === scope.meshDomainId)
        .map(([id, n]) => ({
          upstream: { meshInstanceId: scope.meshInstanceId, meshDomainId: n.domain, meshNodeId: id },
          name: n.name,
          hostname: `${n.name}.lan`,
          osDescription: 'Linux',
          agentOnline: n.online,
          powerState: n.powerState ?? (n.online ? 'on' : 'unknown'),
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
      requestPowerAction: async (request) => {
        const scope = scopes.get(request.siteId);
        if (!scope || scope.meshDomainId !== request.upstream.meshDomainId) throw new Error('scope_denied');
        if (this.powerFailing) throw new AdapterError('upstream_timeout', 'No response to poweraction');
        const nodeId = request.upstream.meshNodeId;
        this.powerRequests.push({ siteId: request.siteId, nodeId, type: request.type });
        return (request.type === 'wake' ? this.wakeResults.get(nodeId) : undefined) ?? { accepted: true };
      },
    };
  }
}
