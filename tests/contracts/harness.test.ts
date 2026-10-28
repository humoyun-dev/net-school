import { get } from 'node:https';
import { MeshControlClient } from '@netschool/meshcentral-adapter';
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

// generateMeshPassword base64url: ~1/64 holatda '-' bilan boshlanadi (CI'da tasodifiy noauth-2d).
test('admin password starting with a dash still logs in', async () => {
  const instance = await startMeshCentral({ adminPassword: `-${'x'.repeat(40)}-Aa1` });
  const client = new MeshControlClient({
    url: instance.url,
    ca: instance.ca,
    username: instance.admin.username,
    password: instance.admin.password,
  });
  try {
    await expect(client.connect()).resolves.toBeUndefined();
  } finally {
    await client.close();
    await instance.stop();
  }
});
