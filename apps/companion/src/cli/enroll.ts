import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { PlatformFacts } from '../core/capabilities.ts';
import { EnrollError, enroll } from '../core/enroll.ts';
import { HubError } from '../core/hub-client.ts';
import { machineDir } from '../core/machine-store.ts';

// Chiqish kodlari: 0 muvaffaqiyat, 2 noto'g'ri foydalanish, 3 hub/TLS/tarmoq xatosi, 4 rad etildi yoki allaqachon ro'yxatdan o'tgan.
const USAGE =
  'usage: enroll --hub <https-origin> [--ca <pem-file>] [--token <token>] [--force]\n  token may also come from NETSCHOOL_ENROLL_TOKEN';

interface Io {
  out(line: string): void;
  err(line: string): void;
}

interface Args {
  hub?: string;
  ca?: string;
  token?: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--force') args.force = true;
    else if (flag === '--hub' || flag === '--ca' || flag === '--token') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return `${flag} needs a value`;
      args[flag.slice(2) as 'hub' | 'ca' | 'token'] = value;
    } else return `unknown argument: ${flag}`;
  }
  return args;
}

function platformFacts(env: NodeJS.ProcessEnv): PlatformFacts {
  const session = env.XDG_SESSION_TYPE;
  return {
    platform: process.platform,
    arch: process.arch,
    sessionType: process.platform === 'linux' && (session === 'wayland' || session === 'x11') ? session : null,
    // Ekran ruxsati faqat Electron ichida aniqlanadi; Companion ishga tushganda capability yangilanadi.
    screenAccess: 'unknown',
  };
}

// Token hech qachon chiqarilmaydi (na muvaffaqiyatda, na xatoda).
export async function runEnrollCli(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    io.err(`${parsed}\n${USAGE}`);
    return 2;
  }
  const token = parsed.token ?? env.NETSCHOOL_ENROLL_TOKEN;
  if (!parsed.hub || !token) {
    io.err(`--hub and an enrollment token are required\n${USAGE}`);
    return 2;
  }
  if (!parsed.hub.startsWith('https://')) {
    io.err('the hub address must be an https origin');
    return 2;
  }
  let ca: string | null = null;
  if (parsed.ca) {
    try {
      ca = readFileSync(parsed.ca, 'utf8');
    } catch {
      io.err(`cannot read the CA file: ${parsed.ca}`);
      return 2;
    }
  }
  try {
    const config = await enroll({
      hubOrigin: parsed.hub,
      token,
      ca,
      hostname: hostname(),
      facts: platformFacts(env),
      dir: machineDir(process.platform, env),
      force: parsed.force,
    });
    io.out(`enrolled: device ${config.deviceId}`);
    return 0;
  } catch (err) {
    if (err instanceof EnrollError) {
      io.err(err.message);
      return 4;
    }
    if (err instanceof HubError) {
      if (err.kind === 'tls') io.err('the hub certificate is not trusted; check --hub and --ca');
      else if (err.kind === 'http' && err.status !== null && err.status < 500) {
        io.err(`the hub rejected the enrollment (${err.status}${err.code ? ` ${err.code}` : ''})`);
        return 4;
      } else io.err(`cannot reach the hub (${err.kind})`);
      return 3;
    }
    if (err instanceof Error && /bare https origin/.test(err.message)) {
      io.err('the hub address must be a bare https origin, e.g. https://hub.school.lan');
      return 2;
    }
    io.err(`enrollment failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    return 3;
  }
}

// `node dist/enroll.mjs ...` sifatida to'g'ridan-to'g'ri ishga tushganda.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runEnrollCli(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
