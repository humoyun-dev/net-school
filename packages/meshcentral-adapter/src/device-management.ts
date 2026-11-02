import type {
  AuthorizedPowerRequest,
  DeviceBinding,
  DeviceEvent,
  DeviceManagementPort,
  DeviceSnapshot,
  EnrollmentResult,
  PowerRequestResult,
  Unsubscribe,
} from '@netschool/domain';
import type { MeshRequester } from './control-client.ts';
import { AdapterError } from './errors.ts';
import { parseDeviceEvent } from './map-events.ts';
import { mapNodesResponse } from './map-nodes.ts';
import { formatNodeId, type SiteMeshScope } from './node-id.ts';

// Upstream meshctrl.js devicepower: 2 — o'chirish, 3 — qayta yuklash, 4 — uxlatish.
const POWER_ACTION_TYPE = { shutdown: 2, reboot: 3, sleep: 4 } as const;

// wakedevices bitta node uchun diagnostik matn qaytaradi (meshuser.js).
function wakeResult(result: unknown): PowerRequestResult {
  if (result === 'ok' || (typeof result === 'string' && /^Used \d+ device\(s\)/.test(result)))
    return { accepted: true };
  if (result === 'No known MAC addresses for this device' || result === 'No network information for this device') {
    return { accepted: false, reason: 'wake_unsupported' };
  }
  if (result === 'Invalid nodeid' || result === 'Invalid domain') return { accepted: false, reason: 'node_missing' };
  throw new AdapterError('invalid_upstream_message', 'Unexpected wakedevices reply', { result });
}

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

  // Har chaqiruv bitta node uchun: ko'p nodeid'li poweraction bitta responseid bilan bir nechta javob yuboradi.
  // poweraction javobi huquq tekshiruvidan oldin 'ok' — bajarilgani faqat kuzatuv bilan aniqlanadi.
  async requestPowerAction(request: AuthorizedPowerRequest): Promise<PowerRequestResult> {
    const scope = this.#sites.get(request.siteId);
    const { upstream } = request;
    if (!scope || scope.meshInstanceId !== upstream.meshInstanceId || scope.meshDomainId !== upstream.meshDomainId) {
      throw new AdapterError('scope_denied', 'Node is outside the site scope');
    }
    const nodeids = [formatNodeId(upstream)];
    if (request.type === 'wake') {
      // Klient 'ok' bo'lmagan result'ni upstream_rejected qiladi; diagnostik matn detail'da.
      const result = await this.#client.request<{ result?: unknown }>('wakedevices', { nodeids }).then(
        (reply) => reply.result ?? 'ok',
        (err: unknown) => {
          if (err instanceof AdapterError && err.code === 'upstream_rejected') return err.detail;
          throw err;
        },
      );
      return wakeResult(result);
    }
    const reply = await this.#client.request<{ result?: unknown }>('poweraction', {
      nodeids,
      actiontype: POWER_ACTION_TYPE[request.type],
    });
    if (reply.result !== 'ok')
      throw new AdapterError('invalid_upstream_message', 'Unexpected poweraction reply', reply);
    return { accepted: true };
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
