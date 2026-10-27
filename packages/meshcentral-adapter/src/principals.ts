import { randomUUID } from 'node:crypto';
import type { UpstreamDeviceRef } from '@netschool/domain';
import type { MeshRequester } from './control-client.ts';
import { AdapterError } from './errors.ts';
import { formatNodeId } from './node-id.ts';
import { generateMeshPassword } from './password.ts';
import { PRINCIPAL_SITE_RIGHTS, rightsFor } from './rights.ts';

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
    const password = generateMeshPassword();
    const userId = `user/${device.meshDomainId}/${username}`;
    const nodeId = formatNodeId(device);
    const rights = rightsFor(mode);

    // randomPassword yuborilmaydi: server unda parolni o'zinikiga almashtiradi (meshuser.js serverCommandAddUser).
    await this.#client.request('adduser', { username, pass: password, siteadmin: PRINCIPAL_SITE_RIGHTS });
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
