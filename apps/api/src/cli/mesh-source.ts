import { request } from 'node:https';
import { agentDownloadPath, ensureDeviceGroup, MeshControlClient } from '@netschool/meshcentral-adapter';
import type { MeshConnection } from '../config/config.ts';
import type { MeshAgentSource } from './types.ts';

const MAX_AGENT_BYTES = 64 * 1024 * 1024;

// Service account bilan guruhni ta'minlaydi va o'rnatuvchini MeshCentral'dan CA va hostname tekshiruvi bilan oladi.
export function meshAgentSource(mesh: MeshConnection): MeshAgentSource {
  return {
    async installer(groupName, arch) {
      const client = new MeshControlClient({ ...mesh, requestTimeoutMs: 10_000 });
      await client.connect();
      try {
        const { meshid } = await ensureDeviceGroup(client, groupName);
        const url = new URL(agentDownloadPath(meshid, arch), mesh.url.replace(/^wss:/, 'https:'));
        const bytes = await new Promise<Buffer>((resolve, reject) => {
          const req = request(url, { ca: mesh.ca, method: 'GET', timeout: 60_000 }, (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`HTTP ${res.statusCode} from ${url.pathname}`));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (c: Buffer) => {
              size += c.length;
              if (size > MAX_AGENT_BYTES) req.destroy(new Error('agent too large'));
              else chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          });
          req.on('timeout', () => req.destroy(new Error('agent download timed out')));
          req.on('error', reject);
          req.end();
        });
        if (bytes.subarray(0, 2).toString('latin1') !== 'MZ')
          throw new Error('downloaded file is not a Windows executable');
        return { meshid, bytes };
      } finally {
        await client.close();
      }
    },
  };
}
