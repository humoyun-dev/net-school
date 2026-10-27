import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MeshControlClient, type MeshControlClientOptions } from '../src/control-client.ts';
import { AdapterError } from '../src/errors.ts';
import { FakeMeshServer, makeCert, tick, until } from './support/fake-mesh-server.ts';

let server: FakeMeshServer;
let client: MeshControlClient | undefined;

beforeEach(async () => {
  server = await FakeMeshServer.start();
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await server.close();
});

function makeClient(overrides: Partial<MeshControlClientOptions> = {}) {
  client = new MeshControlClient({
    url: server.url,
    username: 'admin',
    password: 'secret',
    ca: server.ca,
    requestTimeoutMs: 1_000,
    reconnect: { minDelayMs: 10, maxDelayMs: 40 },
    ...overrides,
  });
  return client;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof AdapterError ? err.code : `not-adapter-error: ${String(err)}`;
  }
  return 'resolved';
}

describe('MeshControlClient', () => {
  test('sends x-meshauth and resolves connect after serverinfo', async () => {
    await makeClient().connect();
    expect(server.connectionCount).toBe(1);
    expect(server.sockets.size).toBe(1);
  });

  test('correlates concurrent responses delivered out of order', async () => {
    const received: Record<string, unknown>[] = [];
    server.handle = (socket, msg) => {
      received.push(msg);
      if (received.length === 3) {
        for (const m of [...received].reverse()) {
          socket.send(JSON.stringify({ action: m.action, responseid: m.responseid, result: 'ok', echo: m.n }));
        }
      }
    };
    const c = makeClient();
    await c.connect();
    const results = await Promise.all([1, 2, 3].map((n) => c.request<{ echo: number }>('ping', { n })));
    expect(results.map((r) => r.echo)).toEqual([1, 2, 3]);
    expect(new Set(received.map((m) => m.responseid)).size).toBe(3);
  });

  test('times out with upstream_timeout', async () => {
    const c = makeClient({ requestTimeoutMs: 50 });
    await c.connect();
    expect(await codeOf(c.request('nodes'))).toBe('upstream_timeout');
  });

  test('maps non-ok result to upstream_rejected', async () => {
    server.handle = (socket, msg) =>
      socket.send(JSON.stringify({ action: msg.action, responseid: msg.responseid, result: 'Invalid rights' }));
    const c = makeClient();
    await c.connect();
    const err = await c.request('adddeviceuser').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('upstream_rejected');
    expect((err as AdapterError).detail).toBe('Invalid rights');
  });

  test('routes unsolicited messages to onMessage', async () => {
    const c = makeClient();
    const seen: unknown[] = [];
    c.onMessage((m) => seen.push(m));
    await c.connect();
    server.send({ action: 'event', event: { action: 'addnode' } });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ action: 'event', event: { action: 'addnode' } });
  });

  test('rejects pending requests and emits resync after reconnect', async () => {
    const c = makeClient();
    let resyncs = 0;
    c.onResync(() => resyncs++);
    await c.connect();
    const pending = c.request('nodes');
    await tick(20);
    server.dropAll();
    expect(await codeOf(pending)).toBe('upstream_unavailable');
    await until(() => resyncs === 1);
    server.handle = (socket, msg) =>
      socket.send(JSON.stringify({ action: msg.action, responseid: msg.responseid, nodes: {} }));
    await expect(c.request('nodes')).resolves.toMatchObject({ nodes: {} });
    expect(resyncs).toBe(1);
  });

  test('drops oversized frames and reconnects', async () => {
    const c = makeClient({ maxMessageBytes: 1024 });
    const seen: unknown[] = [];
    let resyncs = 0;
    c.onMessage((m) => seen.push(m));
    c.onResync(() => resyncs++);
    await c.connect();
    server.send({ action: 'event', pad: 'x'.repeat(2048) });
    await until(() => resyncs === 1);
    expect(seen).toEqual([]);
    expect(server.connectionCount).toBe(2);
  });

  test('fails closed on untrusted certificate', async () => {
    const foreign = await makeCert();
    expect(await codeOf(makeClient({ ca: foreign.cert }).connect())).toBe('upstream_tls_failed');
    expect(await codeOf(makeClient({ servername: 'evil.test' }).connect())).toBe('upstream_tls_failed');
  });

  test('rejects wrong credentials with upstream_auth_failed', async () => {
    expect(await codeOf(makeClient({ password: 'wrong' }).connect())).toBe('upstream_auth_failed');
  });

  test('does not reconnect after auth failure', async () => {
    const c = makeClient();
    await c.connect();
    server.credentials = { user: 'admin', pass: 'rotated' };
    server.dropAll();
    await until(() => server.connectionCount === 2);
    await tick(200);
    expect(server.connectionCount).toBe(2);
    expect(await codeOf(c.request('nodes'))).toBe('upstream_auth_failed');
  });

  test('close() stops reconnecting', async () => {
    const c = makeClient();
    await c.connect();
    await c.close();
    await tick(200);
    expect(server.connectionCount).toBe(1);
    expect(await codeOf(c.request('nodes'))).toBe('upstream_unavailable');
  });
});
