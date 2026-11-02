import { createPrivateKey, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { RequestListener, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { heartbeatResponseSchema } from '@netschool/contracts';
import { makeCert, type TestCert } from '@netschool/test-support';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { startTestApp, type TestApp } from '../../api/test/support/app.ts';
import { seedDevice } from '../../api/test/support/device.ts';
import { seedOrg } from '../../api/test/support/seed.ts';
import { HubClient, HubError } from '../src/core/hub-client.ts';
import { type DeviceIdentity, generateDeviceKey, RequestSigner } from '../src/core/identity.ts';

const clients: HubClient[] = [];
const servers: { close(): Promise<void> }[] = [];

function track(client: HubClient): HubClient {
  clients.push(client);
  return client;
}

async function localServer(cert: TestCert, handler: RequestListener) {
  const server = createServer({ key: cert.key, cert: cert.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  const handle = {
    origin: `https://localhost:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(handle);
  return handle;
}

function localIdentity(): DeviceIdentity {
  const { publicKey, privateKeyPem } = generateDeviceKey();
  return { deviceId: randomUUID(), publicKey, privateKey: createPrivateKey(privateKeyPem) };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const unauthenticated = { error: { code: 'unauthenticated', message: 'Unauthenticated' } };

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

describe('hub client TLS', () => {
  let cert: TestCert;
  beforeAll(async () => {
    cert = await makeCert('localhost');
  });

  test('refuses a hub certificate signed by another CA', async () => {
    let reached = 0;
    const server = await localServer(cert, (_req, res) => {
      reached++;
      json(res, 200, {});
    });
    const other = await makeCert('localhost');
    const client = track(new HubClient({ origin: server.origin, ca: other.cert, signer: null }));
    await expect(client.json('GET', '/x', undefined, null)).rejects.toMatchObject({ name: 'HubError', kind: 'tls' });
    expect(reached).toBe(0);
  });

  test('refuses a certificate issued for another hostname', async () => {
    const wrongName = await makeCert('other.example');
    let reached = 0;
    const server = await localServer(wrongName, (_req, res) => {
      reached++;
      json(res, 200, {});
    });
    // CA'ga ishoniladi, lekin sertifikat `localhost` uchun chiqarilmagan.
    const client = track(new HubClient({ origin: server.origin, ca: wrongName.cert, signer: null }));
    await expect(client.json('GET', '/x', undefined, null)).rejects.toMatchObject({ kind: 'tls' });
    expect(reached).toBe(0);
  });

  test('without a hub CA the system roots apply and a self-signed hub is refused', async () => {
    const server = await localServer(cert, (_req, res) => json(res, 200, {}));
    const client = track(new HubClient({ origin: server.origin, ca: null, signer: null }));
    await expect(client.json('GET', '/x', undefined, null)).rejects.toMatchObject({ kind: 'tls' });
  });

  test('refuses a plain http or non-origin hub url', () => {
    for (const origin of ['http://localhost:1', 'https://localhost/path', 'https://localhost/', 'localhost:443']) {
      expect(() => new HubClient({ origin, ca: null, signer: null }), origin).toThrow(/https/);
    }
  });

  test('the client never disables certificate verification', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|mjs|html)$/.test(name)) files.push(path);
      }
    };
    walk(join(import.meta.dirname, '..', 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED/);
    }
  });
});

describe('hub client requests', () => {
  let cert: TestCert;
  beforeAll(async () => {
    cert = await makeCert('localhost');
  });

  const clientFor = (origin: string, signer: RequestSigner | null = null) =>
    track(new HubClient({ origin, ca: cert.cert, signer }));

  test('parses a successful response with the schema and returns undefined for null schema', async () => {
    const server = await localServer(cert, (_req, res) => json(res, 200, { n: 7 }));
    const client = clientFor(server.origin);
    expect(await client.json('GET', '/x', undefined, z.object({ n: z.number() }))).toEqual({ n: 7 });
    expect(await client.json('GET', '/x', undefined, null)).toBeUndefined();
  });

  test('a non-2xx response becomes an http error with status and code', async () => {
    const server = await localServer(cert, (_req, res) =>
      json(res, 409, { error: { code: 'conflict', message: 'Lesson has ended' } }),
    );
    await expect(clientFor(server.origin).json('POST', '/x', {}, null)).rejects.toMatchObject({
      kind: 'http',
      status: 409,
      code: 'conflict',
    });
  });

  test('a response that does not match the schema is invalid_response', async () => {
    const server = await localServer(cert, (_req, res) => json(res, 200, { n: 'seven' }));
    await expect(
      clientFor(server.origin).json('GET', '/x', undefined, z.object({ n: z.number() })),
    ).rejects.toMatchObject({ kind: 'http', status: 200, code: 'invalid_response' });
  });

  test('connection refused is a network error and silence is a timeout', async () => {
    const closed = await localServer(cert, (_req, res) => json(res, 200, {}));
    const origin = closed.origin;
    await closed.close();
    await expect(clientFor(origin).json('GET', '/x', undefined, null)).rejects.toMatchObject({ kind: 'network' });

    const silent = await localServer(cert, () => {});
    await expect(clientFor(silent.origin).json('GET', '/x', undefined, null, { timeoutMs: 100 })).rejects.toMatchObject(
      { kind: 'timeout' },
    );
  });

  test('an aborted request fails as a network error', async () => {
    const silent = await localServer(cert, () => {});
    const abort = new AbortController();
    const pending = clientFor(silent.origin).json('GET', '/x', undefined, null, { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toMatchObject({ kind: 'network', code: 'aborted' });
  });

  test('re-signs once after a reordering 401 and succeeds', async () => {
    const seen: string[] = [];
    const server = await localServer(cert, (req, res) => {
      seen.push(String(req.headers['x-ns-timestamp']));
      if (seen.length === 1) json(res, 401, unauthenticated);
      else json(res, 200, { ok: true });
    });
    const client = clientFor(server.origin, new RequestSigner(localIdentity()));
    expect(await client.json('POST', '/x', {}, z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(Number(seen[1])).toBeGreaterThan(Number(seen[0]));
  });

  test('re-signs once after a reordering 401 and then gives up', async () => {
    let requests = 0;
    const server = await localServer(cert, (_req, res) => {
      requests++;
      json(res, 401, unauthenticated);
    });
    const client = clientFor(server.origin, new RequestSigner(localIdentity()));
    await expect(client.json('POST', '/x', {}, null)).rejects.toMatchObject({
      kind: 'http',
      status: 401,
      code: 'unauthenticated',
    });
    expect(requests).toBe(2);
  });

  test('an unsigned client does not retry a 401', async () => {
    let requests = 0;
    const server = await localServer(cert, (_req, res) => {
      requests++;
      json(res, 401, unauthenticated);
    });
    await expect(clientFor(server.origin).json('POST', '/x', {}, null)).rejects.toMatchObject({ status: 401 });
    expect(requests).toBe(1);
  });

  test('control lane sends one request at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const server = await localServer(cert, (_req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        json(res, 200, {});
      }, 40);
    });
    const client = clientFor(server.origin);
    await Promise.all([1, 2, 3].map(() => client.json('GET', '/x', undefined, null)));
    expect(maxInFlight).toBe(1);
  });

  test('a long poll does not block control requests', async () => {
    const server = await localServer(cert, (req, res) => {
      if (req.url === '/slow') setTimeout(() => json(res, 200, {}), 400);
      else json(res, 200, {});
    });
    const client = clientFor(server.origin);
    let slowDone = false;
    const slow = client.json('GET', '/slow', undefined, null, { lane: 'poll', timeoutMs: 5_000 }).then(() => {
      slowDone = true;
    });
    await client.json('GET', '/fast', undefined, null);
    expect(slowDone).toBe(false);
    await slow;
  });
});

describe('hub client against the real hub', () => {
  let app: TestApp;
  let orgId: string;
  let siteId: string;

  // Har test o'z qurilmasi bilan: hub `ts > last_signed_ts` talab qiladi, boshqa imzochi yozgan qiymat bu testni buzmasin.
  const freshIdentity = async (): Promise<DeviceIdentity> => {
    const key = generateDeviceKey();
    const deviceId = await seedDevice(app.db.db, orgId, siteId, key.publicKey);
    return { deviceId, publicKey: key.publicKey, privateKey: createPrivateKey(key.privateKeyPem) };
  };

  beforeAll(async () => {
    app = await startTestApp();
    ({ orgId, siteId } = await seedOrg(app.db.db));
  });
  afterAll(async () => {
    await app?.close();
  });

  test('a signed heartbeat is accepted', async () => {
    const identity = await freshIdentity();
    const client = track(new HubClient({ origin: app.origin, ca: app.ca, signer: new RequestSigner(identity) }));
    const res = await client.json('POST', '/api/v1/device/heartbeat', {}, heartbeatResponseSchema);
    expect(res).toEqual({ heartbeatIntervalSeconds: 10, lesson: null });
  });

  test('a skewed device clock is corrected from the hub Date header', async () => {
    // Qurilma soati 2 daqiqa orqada: hub ±30 s dan tashqari imzoni rad etadi.
    const identity = await freshIdentity();
    const signer = new RequestSigner(identity, () => Date.now() - 120_000);
    let signs = 0;
    const sign = signer.sign.bind(signer);
    signer.sign = (...args) => {
      signs++;
      return sign(...args);
    };
    const client = track(new HubClient({ origin: app.origin, ca: app.ca, signer }));

    expect((await client.json('POST', '/api/v1/device/heartbeat', {}, heartbeatResponseSchema)).lesson).toBeNull();
    expect(signs).toBe(2); // 401, so'ng tuzatilgan soat bilan qayta imzo
    await client.json('POST', '/api/v1/device/heartbeat', {}, heartbeatResponseSchema);
    expect(signs).toBe(3); // offset saqlanadi: keyingi so'rov birinchi urinishda o'tadi
  });
});

test('HubError carries its fields', () => {
  const err = new HubError('http', 'boom', 418, 'teapot');
  expect(err).toMatchObject({ name: 'HubError', kind: 'http', status: 418, code: 'teapot', message: 'boom' });
  expect(err).toBeInstanceOf(Error);
});
