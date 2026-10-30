import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import type { INestApplication, Type } from '@nestjs/common';
import { makeCert } from '@netschool/test-support';
import { createApp } from '../../src/app.ts';
import type { DeviceManagementFactory } from '../../src/modules/devices/mesh.ts';
import type { RemoteUpstream } from '../../src/modules/remote-sessions/remote-gateway.ts';
import { createTestDb, type TestDb } from './db.ts';

export interface TestResponse {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: test javoblarini erkin o'qish uchun
  json: any;
}

export interface TestApp {
  origin: string;
  db: TestDb;
  ca: string;
  request(
    method: string,
    path: string,
    init?: { body?: unknown; cookie?: string; headers?: Record<string, string>; origin?: string | null },
  ): Promise<TestResponse>;
  // Nest provider'iga to'g'ridan-to'g'ri kirish (workerlar, notifier).
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}

export async function startTestApp(
  opts: {
    now?: () => number;
    controllers?: Type[];
    db?: TestDb;
    deviceManagement?: DeviceManagementFactory | null;
    // Soxta remote upstream; berilmasa gateway o'chiq. Gateway listener'ini test o'zi ochadi (listen).
    remote?: RemoteUpstream | null;
  } = {},
): Promise<TestApp> {
  const db = opts.db ?? (await createTestDb());
  const cert = await makeCert('localhost');
  const port = await freePort();
  const origin = `https://localhost:${port}`;
  const remote = opts.remote ?? null;
  const app: INestApplication = await createApp(
    {
      port,
      host: '127.0.0.1',
      publicOrigin: origin,
      tls: cert,
      databaseUrl: 'unused',
      // Gateway upstream endpoint'i config.mesh'dan olinadi; soxta upstream bilan unga hech qachon ulanilmaydi.
      mesh: remote
        ? { url: 'wss://127.0.0.1:9/control.ashx', username: 'unused', password: 'unused', ca: cert.cert }
        : null,
      meshInstanceId: 'local',
      gateway: remote ? { port: 0, publicOrigin: 'https://localhost:8444' } : null,
    },
    {
      db: db.db,
      now: opts.now,
      controllers: opts.controllers,
      deviceManagement: opts.deviceManagement ?? null,
      remote,
      logger: false,
    },
  );
  await app.listen(port, '127.0.0.1');

  return {
    origin,
    db,
    ca: cert.cert,
    request(method, path, init = {}) {
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const headers: Record<string, string> = { ...init.headers };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (init.cookie) headers.cookie = init.cookie;
      // Brauzer o'zgartiruvchi so'rovlarda Origin yuboradi; null — Origin'siz so'rov.
      if (init.origin !== null && !('origin' in headers)) headers.origin = init.origin ?? origin;
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          { host: '127.0.0.1', port, servername: 'localhost', ca: cert.cert, method, path, headers },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              const h = new Headers();
              for (const [k, v] of Object.entries(res.headers)) {
                if (Array.isArray(v)) for (const item of v) h.append(k, item);
                else if (v !== undefined) h.set(k, v);
              }
              let json: unknown;
              try {
                json = text ? JSON.parse(text) : undefined;
              } catch {
                json = undefined;
              }
              resolve({ status: res.statusCode ?? 0, headers: h, json });
            });
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    },
    get<T>(token: unknown): T {
      return app.get(token as never, { strict: false }) as T;
    },
    async close() {
      await app.close();
      // Tashqaridan berilgan DB'ni chaqiruvchi yopadi.
      if (!opts.db) await db.close().catch(() => {});
    },
  };
}
