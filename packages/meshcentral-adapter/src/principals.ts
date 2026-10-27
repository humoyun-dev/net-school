import { randomBytes, randomUUID } from 'node:crypto';
import type { UpstreamDeviceRef } from '@netschool/domain';
import type { MeshRequester } from './control-client.ts';
import { AdapterError } from './errors.ts';
import { formatNodeId } from './node-id.ts';
import { rightsFor } from './rights.ts';

export interface SessionPrincipal {
  userId: string;
  username: string;
  password: string;
  nodeId: string;
  rights: number;
}

// Spec §5.2: har remote sessiya uchun qisqa umrli, faqat bitta node'ga ruxsatli MeshCentral hisobi.
export class MeshCentralPrincipals {
  readonly #client: MeshRequester;

  constructor(client: MeshRequester) {
    this.#client = client;
  }

  async create(device: UpstreamDeviceRef, mode: 'view' | 'control'): Promise<SessionPrincipal> {
    const username = `ns-sess-${randomUUID()}`;
    const password = randomBytes(32).toString('base64url');
    const userId = `user/${device.meshDomainId}/${username}`;
    const nodeId = formatNodeId(device);
    const rights = rightsFor(mode);

    await this.#client.request('adduser', { username, pass: password, randomPassword: true, siteadmin: 0 });
    try {
      await this.#client.request('adddeviceuser', { userids: [userId], nodeid: nodeId, rights });
    } catch (err) {
      await this.revoke(userId).catch(() => {});
      throw err;
    }
    return { userId, username, password, nodeId, rights };
  }

  async revoke(userId: string): Promise<void> {
    try {
      await this.#client.request('deleteuser', { userid: userId });
    } catch (err) {
      if (err instanceof AdapterError && err.code === 'upstream_rejected' && err.detail === 'User does not exists')
        return;
      throw err;
    }
  }
}
