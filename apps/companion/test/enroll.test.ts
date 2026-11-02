import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heartbeatResponseSchema } from '@netschool/contracts';
import { makeCert } from '@netschool/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestApp, type TestApp } from '../../api/test/support/app.ts';
import { loginAs } from '../../api/test/support/login.ts';
import { seedOrg, seedUser } from '../../api/test/support/seed.ts';
import { runEnrollCli } from '../src/cli/enroll.ts';
import type { PlatformFacts } from '../src/core/capabilities.ts';
import { EnrollError, enroll, sanitizeHostname } from '../src/core/enroll.ts';
import { HubClient } from '../src/core/hub-client.ts';
import { RequestSigner } from '../src/core/identity.ts';
import { loadEnrollment } from '../src/core/machine-store.ts';

let app: TestApp;
let admin: string;
let siteId: string;
let caFile: string;

const facts: PlatformFacts = { platform: 'win32', arch: 'x64', sessionType: null, screenAccess: 'unknown' };
const tempDir = () => mkdtempSync(join(tmpdir(), 'ns-enroll-'));

beforeAll(async () => {
  app = await startTestApp();
  const org = await seedOrg(app.db.db);
  siteId = org.siteId;
  await seedUser(app.db.db, org.orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  admin = await loginAs(app, 'admin1');
  caFile = join(tempDir(), 'hub-ca.pem');
  writeFileSync(caFile, app.ca);
});
afterAll(async () => {
  await app?.close();
});

async function newToken(): Promise<string> {
  const res = await app.request('POST', '/api/v1/enrollments', { body: { siteId }, cookie: admin });
  expect(res.status).toBe(201);
  return res.json.token as string;
}

const input = (token: string, dir: string, over: Partial<Parameters<typeof enroll>[0]> = {}) => ({
  hubOrigin: app.origin,
  token,
  ca: app.ca,
  hostname: 'pc-01.school.lan',
  facts,
  dir,
  ...over,
});

describe('enroll', () => {
  test('enrolls and the saved identity can heartbeat', async () => {
    const dir = tempDir();
    const config = await enroll(input(await newToken(), dir));
    expect(config).toMatchObject({ hubOrigin: app.origin, siteId });

    const saved = loadEnrollment(dir);
    if (!saved) throw new Error('not saved');
    expect(saved.config).toEqual(config);
    expect(saved.ca).toBe(app.ca);
    const client = new HubClient({
      origin: saved.config.hubOrigin,
      ca: saved.ca,
      signer: new RequestSigner(saved.identity),
    });
    try {
      const res = await client.json('POST', '/api/v1/device/heartbeat', {}, heartbeatResponseSchema);
      expect(res.heartbeatIntervalSeconds).toBe(10);
    } finally {
      client.close();
    }
    // Hub qurilmani hisobotdagi capability bilan saqlagan.
    const devices = await app.request('GET', `/api/v1/sites/${siteId}/devices`, { cookie: admin });
    expect(JSON.stringify(devices.json)).toContain(config.deviceId);
  });

  test('a used or unknown token is rejected and nothing is written', async () => {
    const unknown = tempDir();
    await expect(enroll(input(`nse_${'A'.repeat(43)}`, unknown))).rejects.toMatchObject({ kind: 'http' });
    expect(readdirSync(unknown)).toEqual([]);

    const token = await newToken();
    await enroll(input(token, tempDir()));
    const reused = tempDir();
    await expect(enroll(input(token, reused))).rejects.toMatchObject({ kind: 'http' });
    expect(readdirSync(reused)).toEqual([]);
  });

  test('an untrusted hub certificate fails before anything is written', async () => {
    const token = await newToken();
    const dir = join(tempDir(), 'companion');
    const other = await makeCert('localhost');
    await expect(enroll(input(token, dir, { ca: other.cert }))).rejects.toMatchObject({ kind: 'tls' });
    // Tizim root'lari: o'z-o'zidan imzolangan hub'ga ishonilmaydi.
    await expect(enroll(input(token, dir, { ca: null }))).rejects.toMatchObject({ kind: 'tls' });
    expect(existsSync(dir)).toBe(false);
    // Token sarflanmagan: to'g'ri CA bilan o'sha token ishlaydi.
    await enroll(input(token, tempDir()));
  });

  test('refuses to overwrite an existing enrollment without force', async () => {
    const dir = tempDir();
    const first = await enroll(input(await newToken(), dir));
    const before = readFileSync(join(dir, 'device.json'), 'utf8');

    const second = await newToken();
    await expect(enroll(input(second, dir))).rejects.toBeInstanceOf(EnrollError);
    await expect(enroll(input(second, dir))).rejects.toMatchObject({ code: 'already_enrolled' });
    expect(readFileSync(join(dir, 'device.json'), 'utf8')).toBe(before);

    const replaced = await enroll(input(second, dir, { force: true }));
    expect(replaced.deviceId).not.toBe(first.deviceId);
    expect(loadEnrollment(dir)?.config.deviceId).toBe(replaced.deviceId);
  });

  test('hostnames are sanitised to what the hub accepts', () => {
    expect(sanitizeHostname("Humoyun's MacBook")).toBe("Humoyun's-MacBook");
    expect(sanitizeHostname('')).toBe('unknown');
    expect(sanitizeHostname('x'.repeat(400))).toHaveLength(253);
    expect(sanitizeHostname('pc-01.school.lan')).toBe('pc-01.school.lan');
  });
});

describe('enroll CLI', () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runEnrollCli(argv, env, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, text: [...out, ...err].join('\n') };
  };

  test('the CLI enrolls with the token from the environment and never prints the token', async () => {
    const dir = tempDir();
    const token = await newToken();
    const { code, text } = await run(['--hub', app.origin, '--ca', caFile], {
      NETSCHOOL_COMPANION_DIR: dir,
      NETSCHOOL_ENROLL_TOKEN: token,
    });
    expect(code).toBe(0);
    const saved = loadEnrollment(dir);
    expect(text).toContain(saved?.config.deviceId ?? 'missing');
    expect(text).not.toContain(token);

    // Qaytadan: allaqachon ro'yxatdan o'tgan → 4, token yana ko'rinmaydi.
    const again = await run(['--hub', app.origin, '--ca', caFile, '--token', token], { NETSCHOOL_COMPANION_DIR: dir });
    expect(again.code).toBe(4);
    expect(again.text).not.toContain(token);
  });

  test('exit codes: usage 2, hub or TLS failure 3, rejection 4', async () => {
    const dir = tempDir();
    const env = { NETSCHOOL_COMPANION_DIR: dir };
    expect((await run([], env)).code).toBe(2);
    expect((await run(['--hub', app.origin], env)).code).toBe(2); // token yo'q
    expect((await run(['--hub', 'http://hub.school.lan', '--token', 'x'], env)).code).toBe(2);
    expect((await run(['--hub', app.origin, '--ca', '/no/such/file.pem', '--token', 'x'], env)).code).toBe(2);
    expect((await run(['--bogus'], env)).code).toBe(2);

    const token = await newToken();
    const tls = await run(['--hub', app.origin, '--token', token], env); // CA yo'q: tizim root'lari
    expect(tls.code).toBe(3);
    expect(tls.text).not.toContain(token);

    const unknown = `nse_${'B'.repeat(43)}`;
    const rejected = await run(['--hub', app.origin, '--ca', caFile, '--token', unknown], env);
    expect(rejected.code).toBe(4);
    expect(rejected.text).not.toContain(unknown);
    expect(readdirSync(dir)).toEqual([]);
  });
});
