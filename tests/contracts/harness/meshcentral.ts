import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const upstreamDir = resolve(import.meta.dirname, '../../../infra/meshcentral/upstream');
const READY_TIMEOUT_MS = 150_000;

export interface MeshCentralInstance {
  url: string; // wss://localhost:<port>/control.ashx
  ca: string; // datapath/root-cert-public.crt PEM
  admin: { username: string; password: string };
  restart(): Promise<void>; // bir xil datapath/port bilan to'xtatib qayta ishga tushiradi
  stop(): Promise<void>; // process kill + datapath o'chirish
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

function meshcentral(datapath: string, ...args: string[]) {
  return run(process.execPath, ['meshcentral.js', '--datapath', datapath, ...args], {
    cwd: upstreamDir,
    timeout: READY_TIMEOUT_MS,
  });
}

function httpsOk(url: string, ca: string): Promise<boolean> {
  return new Promise((done) => {
    get(url, { ca, timeout: 2_000 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    })
      .on('error', () => done(false))
      .on('timeout', function (this: { destroy(): void }) {
        this.destroy();
      });
  });
}

async function waitReady(url: string, datapath: string, logs: () => string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ca = await readFile(join(datapath, 'root-cert-public.crt'), 'utf8').catch(() => null);
    if (ca && (await httpsOk(url, ca))) return ca;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`MeshCentral ${READY_TIMEOUT_MS} ms ichida tayyor bo'lmadi:\n${logs()}`);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((r) => child.once('exit', () => r()));
}

export async function startMeshCentral(): Promise<MeshCentralInstance> {
  const datapath = await mkdtemp(join(tmpdir(), 'ns-mc-'));
  const port = await freePort();
  const config = {
    settings: {
      cert: 'localhost',
      port,
      redirPort: 0,
      exactPorts: true,
      selfUpdate: false,
      lanOnly: true,
      autoBackup: false,
      filesPath: join(datapath, 'files'),
    },
    domains: { '': { newAccounts: false } },
  };
  await writeFile(join(datapath, 'config.json'), JSON.stringify(config, null, 2));

  const admin = { username: 'admin', password: randomBytes(18).toString('base64url') };
  await meshcentral(
    datapath,
    '--createaccount',
    admin.username,
    '--pass',
    admin.password,
    '--email',
    'admin@netschool.test',
  );
  await meshcentral(datapath, '--adminaccount', admin.username);

  const httpsUrl = `https://localhost:${port}/`;
  let output = '';
  let child: ChildProcess;
  const launch = async () => {
    output = '';
    child = spawn(process.execPath, ['meshcentral.js', '--datapath', datapath], { cwd: upstreamDir });
    child.stdout?.on('data', (d) => {
      output += d;
    });
    child.stderr?.on('data', (d) => {
      output += d;
    });
    return waitReady(httpsUrl, datapath, () => output);
  };
  const halt = async () => {
    child.kill('SIGTERM');
    await exited(child);
  };

  const ca = await launch();
  return {
    url: `wss://localhost:${port}/control.ashx`,
    ca,
    admin,
    async restart() {
      await halt();
      await launch();
    },
    async stop() {
      await halt();
      await rm(datapath, { recursive: true, force: true });
    },
  };
}
