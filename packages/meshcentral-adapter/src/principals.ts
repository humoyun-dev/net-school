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

// Per-sessiya principal username'i shu prefiks + NetSchool sessiya id'si; ro'yxatlash faqat shularni ajratib oladi.
export const SESSION_PRINCIPAL_PREFIX = 'ns-sess-';

// MeshCentral username'iga mos, '/' va bo'shliqsiz sessiya id'si (API doim UUID beradi).
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

// Spec §5.2: har remote sessiya uchun qisqa umrli, faqat bitta node'ga ruxsatli MeshCentral hisobi.
export class MeshCentralPrincipals {
  readonly #client: MeshRequester;

  constructor(client: MeshRequester) {
    this.#client = client;
  }

  async create(device: UpstreamDeviceRef, mode: 'view' | 'control', sessionId: string): Promise<SessionPrincipal> {
    if (!SESSION_ID.test(sessionId)) throw new TypeError('Invalid session id for a MeshCentral principal');
    const username = `${SESSION_PRINCIPAL_PREFIX}${sessionId}`;
    const password = generateMeshPassword();
    // MeshCentral user id'dagi nomni kichik harfga o'tkazadi (name esa asl holida qoladi).
    const userId = `user/${device.meshDomainId}/${username.toLowerCase()}`;
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

  // Qayta ishga tushganda yetim qolgan principal'larni topish uchun: faqat prefiksli user'lar.
  // `users` muvaffaqiyatda responseid emas, tag qaytaradi; huquq yetmasa responseid bilan rad javobi.
  async listSessionPrincipals(): Promise<{ userId: string; sessionId: string }[]> {
    const { users } = await this.#client.request<{ users?: { _id?: unknown; name?: unknown }[] }>(
      'users',
      {},
      { correlate: 'tag' },
    );
    const found: { userId: string; sessionId: string }[] = [];
    for (const user of users ?? []) {
      if (typeof user._id !== 'string' || typeof user.name !== 'string') continue;
      if (!user.name.startsWith(SESSION_PRINCIPAL_PREFIX)) continue;
      const sessionId = user.name.slice(SESSION_PRINCIPAL_PREFIX.length);
      if (SESSION_ID.test(sessionId)) found.push({ userId: user._id, sessionId });
    }
    return found;
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
