import { get } from 'node:https';
import { expect, test } from 'vitest';
import { startMeshCentral } from './harness/meshcentral.ts';

function httpsStatus(url: string, ca: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, { ca }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

test('starts a pinned MeshCentral and serves TLS signed by its own CA', async () => {
  const instance = await startMeshCentral();
  const httpsUrl = instance.url.replace('wss://', 'https://').replace('/control.ashx', '/');
  try {
    expect(await httpsStatus(httpsUrl, instance.ca)).toBe(200);
  } finally {
    await instance.stop();
  }
  await expect(httpsStatus(httpsUrl, instance.ca)).rejects.toThrow();
});
