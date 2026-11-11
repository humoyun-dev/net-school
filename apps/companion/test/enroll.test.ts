import { createPrivateKey, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heartbeatResponseSchema } from '@netschool/contracts';
import { makeCert } from '@netschool/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestApp, type TestApp } from '../../api/test/support/app.ts';
import { helperRequest } from '../../api/test/support/device.ts';
import { loginAs } from '../../api/test/support/login.ts';
import { seedOrg, seedUser } from '../../api/test/support/seed.ts';
import { runEnrollCli } from '../src/cli/enroll.ts';
import type { PlatformFacts } from '../src/core/capabilities.ts';
import { EnrollError, enroll, sanitizeHostname } from '../src/core/enroll.ts';
import { HelperError, type HelperPort, helperCli, type RunFile } from '../src/core/helper.ts';
import { HubClient } from '../src/core/hub-client.ts';
import { claimProof, generateDeviceKey, RequestSigner } from '../src/core/identity.ts';
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

// Helper'ning xotiradagi o'rinbosari: kalitni o'zi yaratadi va proof beradi (haqiqiysi Go'da, claim-proof fixture).
function fakeHelper() {
  const pair = generateDeviceKey();
  const key = { publicKey: pair.publicKey, privateKey: createPrivateKey(pair.privateKeyPem) };
  const calls: string[][] = [];
  const port: HelperPort = {
    async helperKey(token) {
      calls.push(['helper-key', token]);
      return { helperPublicKey: key.publicKey, helperProof: claimProof(key.privateKey, token, key.publicKey) };
    },
    async setHub(origin, deviceId) {
      calls.push(['set-hub', origin, deviceId]);
    },
  };
  return { port, calls, key };
}

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

  // OS helper (P2d1) o'z kaliti bilan imzolaydi. Kalitni helper o'z katalogida yaratadi (`helper-key`), enroll faqat
  // ochiq kalit va proof'ni claim'ga qo'shadi va claim'dan keyin hub sozlamalarini beradi (`set-hub`).
  test('enroll writes a helper key and sends its proof', async () => {
    const dir = tempDir();
    const { port, calls, key } = fakeHelper();
    const token = await newToken();
    const config = await enroll(input(token, dir, { helper: port }));
    expect(calls).toEqual([
      ['helper-key', token],
      ['set-hub', app.origin, config.deviceId],
    ]);
    // enroll helper kalitini hech qachon o'zi yozmaydi.
    expect(readdirSync(dir).sort()).toEqual(['device.json', 'device.key', 'hub-ca.pem']);

    // Hub helper kalitini qabul qilgan: helper imzosi bilan helper yo'li ishlaydi.
    const signer = {
      publicKey: key.publicKey,
      sign: (m: Buffer | string) => sign(null, Buffer.from(m), key.privateKey).toString('base64url'),
    };
    const res = await helperRequest(app, signer, config.deviceId, 'GET', '/api/v1/device/helper/lock-state');
    expect(res.status).toBe(200);
  });

  test('a helper-key failure spends no token and writes nothing', async () => {
    const dir = tempDir();
    const token = await newToken();
    const failing: HelperPort = {
      helperKey: async () => {
        throw new HelperError('helper-key', 5, 'netschool-helper helper-key failed (exit 5)');
      },
      setHub: async () => {},
    };
    await expect(enroll(input(token, dir, { helper: failing }))).rejects.toBeInstanceOf(HelperError);
    expect(readdirSync(dir)).toEqual([]);
    // Token sarflanmagan.
    await enroll(input(token, tempDir()));
  });

  test('the helper is called with an absolute path, fixed arguments and no shell', async () => {
    const runs: [string, string[]][] = [];
    const run: RunFile = async (file, args) => {
      runs.push([file, args]);
      return args[0] === 'helper-key'
        ? { code: 0, stdout: '{"helperPublicKey":"AAA","helperProof":"BBB"}\n', stderr: '' }
        : { code: 0, stdout: 'ok\n', stderr: '' };
    };
    const exe = 'C:\\pkg\\netschool-helper.exe';
    const port = helperCli({ exe, caFile: 'C:\\certs\\hub-ca.pem', rotate: true, run });
    expect(await port.helperKey('nse_tok')).toEqual({ helperPublicKey: 'AAA', helperProof: 'BBB' });
    await port.setHub('https://hub.school.lan', '0b6f3c1e-8d2a-4c7e-9f10-2a3b4c5d6e7f');
    expect(runs).toEqual([
      [exe, ['helper-key', '--token', 'nse_tok', '--rotate']],
      [
        exe,
        [
          'set-hub',
          '--origin',
          'https://hub.school.lan',
          '--device-id',
          '0b6f3c1e-8d2a-4c7e-9f10-2a3b4c5d6e7f',
          '--ca-file',
          'C:\\certs\\hub-ca.pem',
        ],
      ],
    ]);
    // CA'siz va --force'siz.
    runs.length = 0;
    const plain = helperCli({ exe, caFile: null, rotate: false, run });
    await plain.helperKey('nse_tok');
    await plain.setHub('https://hub', 'id');
    expect(runs.map(([, a]) => a)).toEqual([
      ['helper-key', '--token', 'nse_tok'],
      ['set-hub', '--origin', 'https://hub', '--device-id', 'id'],
    ]);
    expect(() => helperCli({ exe: 'netschool-helper.exe', caFile: null, rotate: false, run })).toThrow(/absolute/);
    expect(() => helperCli({ exe, caFile: 'hub-ca.pem', rotate: false, run })).toThrow(/absolute/);

    // Xato: chiqish kodi va stderr, token xabarda yo'q; kutilmagan stdout rad etiladi.
    const failing = helperCli({
      exe,
      caFile: null,
      rotate: false,
      run: async () => ({
        code: 5,
        stdout: '',
        stderr: 'helper-key administrator sifatida ishga tushirilishi kerak\n',
      }),
    });
    const err = await failing.helperKey('nse_secret').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect(err).toMatchObject({ step: 'helper-key', exitCode: 5 });
    expect(String((err as Error).message)).not.toContain('nse_secret');
    const garbage = helperCli({
      exe,
      caFile: null,
      rotate: false,
      run: async () => ({ code: 0, stdout: 'nope', stderr: '' }),
    });
    await expect(garbage.helperKey('t')).rejects.toBeInstanceOf(HelperError);
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
    // Yozish huquqi oldindan tekshiriladi (katalog yaratiladi), lekin enrollment fayllari yo'q.
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    // Token sarflanmagan: to'g'ri CA bilan o'sha token ishlaydi.
    await enroll(input(token, tempDir()));
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unwritable machine directory fails before the token is spent',
    async () => {
      const token = await newToken();
      const parent = tempDir();
      chmodSync(parent, 0o555); // admin huquqisiz ishga tushirilgan enroll
      try {
        await expect(enroll(input(token, join(parent, 'companion')))).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        chmodSync(parent, 0o755);
      }
      // Token sarflanmagan: huquq bilan qayta urinish o'tadi.
      await enroll(input(token, tempDir()));
    },
  );

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

  test('the CLI hands the helper the absolute CA path and maps helper failures to exit codes', async () => {
    const seen: { caFile: string | null; rotate: boolean }[] = [];
    const runWith = async (argv: string[], port: HelperPort) => {
      const out: string[] = [];
      const code = await runEnrollCli(
        argv,
        { NETSCHOOL_COMPANION_DIR: tempDir() },
        { out: (s) => out.push(s), err: (s) => out.push(s) },
        {
          helper: (opts) => {
            seen.push(opts);
            return port;
          },
        },
      );
      return { code, text: out.join('\n') };
    };
    const ok = fakeHelper();
    const token = await newToken();
    const done = await runWith(['--hub', app.origin, '--ca', caFile, '--token', token, '--force'], ok.port);
    expect(done.code).toBe(0);
    expect(seen.at(-1)).toEqual({ caFile, rotate: true });
    expect(ok.calls.map((c) => c[0])).toEqual(['helper-key', 'set-hub']);

    const keyFails: HelperPort = {
      helperKey: async () => {
        throw new HelperError('helper-key', 5, 'netschool-helper helper-key failed (exit 5)');
      },
      setHub: async () => {},
    };
    const second = await newToken();
    const denied = await runWith(['--hub', app.origin, '--ca', caFile, '--token', second], keyFails);
    expect(denied.code).toBe(2);
    expect(denied.text).toMatch(/administrator/);
    expect(seen.at(-1)).toEqual({ caFile, rotate: false });

    // Bir helper kaliti hub'da faqat bitta qurilmada (unique): yangi kalit bilan.
    const hubFails: HelperPort = {
      helperKey: fakeHelper().port.helperKey,
      setHub: async () => {
        throw new HelperError('set-hub', 1, 'netschool-helper set-hub failed (exit 1)');
      },
    };
    const late = await runWith(['--hub', app.origin, '--ca', caFile, '--token', second], hubFails);
    expect(late.code).toBe(3);
    expect(late.text).toMatch(/enrolled, but the helper/);
    expect(late.text).not.toContain(second);
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
