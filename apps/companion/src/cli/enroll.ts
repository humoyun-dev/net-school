import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PlatformFacts } from '../core/capabilities.ts';
import { EnrollError, enroll } from '../core/enroll.ts';
import { HelperError, type HelperPort, helperCli } from '../core/helper.ts';
import { HubError } from '../core/hub-client.ts';
import { machineDir } from '../core/machine-store.ts';

// Chiqish kodlari: 0 muvaffaqiyat, 2 noto'g'ri foydalanish yoki helper kalitini tayyorlab bo'lmadi, 3 hub/TLS/tarmoq
// xatosi yoki claim'dan keyin helper konfiguratsiyasi yozilmadi, 4 rad etildi yoki allaqachon ro'yxatdan o'tgan.
const USAGE =
  'usage: enroll --hub <https-origin> [--ca <pem-file>] [--token <token>] [--force]\n  token may also come from NETSCHOOL_ENROLL_TOKEN';

interface Io {
  out(line: string): void;
  err(line: string): void;
}

// Paketdagi joylashuv: <paket>/resources/app/dist/enroll.mjs → <paket>/netschool-helper.exe.
export function packagedHelperExe(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', '..', '..', 'netschool-helper.exe');
}

export interface EnrollCliOptions {
  // Windows'da helper (testlar soxta port beradi). null — helper yo'q (boshqa OS).
  helper?: (opts: { ca: string | null; rotate: boolean }) => HelperPort | null;
}

function defaultHelper(opts: { ca: string | null; rotate: boolean }): HelperPort | null {
  if (process.platform !== 'win32') return null;
  const exe = packagedHelperExe(import.meta.url);
  if (!existsSync(exe)) throw new Error(`netschool-helper.exe was not found next to the package: ${exe}`);
  return helperCli({ exe, ...opts });
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
export async function runEnrollCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  options: EnrollCliOptions = {},
): Promise<number> {
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
      // Windows muharrirlari qo'shadigan UTF-8 BOM olib tashlanadi (keyin CA faqat ASCII bo'lishi kerak).
      ca = readFileSync(parsed.ca, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      io.err(`cannot read the CA file: ${parsed.ca}`);
      return 2;
    }
  }
  let helper: HelperPort | null;
  try {
    // --force: yangi qurilma yozuvi; eski yozuvdagi helper kaliti hub'da band (unique), shuning uchun yangisi.
    // CA helper'ga yo'l bilan emas, enroll o'qigan va tekshirgan aynan shu matn bilan (set-hub stdin'i) beriladi.
    helper = (options.helper ?? defaultHelper)({ ca, rotate: parsed.force });
  } catch (err) {
    io.err(err instanceof Error ? err.message : 'the helper is not available');
    return 2;
  }
  try {
    const config = await enroll({
      helper,
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
    if (err instanceof HelperError) {
      if (err.step === 'helper-key') {
        io.err(`${err.message}${err.exitCode === 5 ? '; run enroll as an administrator' : ''}`);
        return 2;
      }
      io.err(`enrolled, but the helper hub settings were not written: ${err.message}`);
      return 3;
    }
    if (err instanceof EnrollError) {
      io.err(err.message);
      return err.code === 'invalid_ca' ? 2 : 4;
    }
    if (err instanceof HubError) {
      if (err.kind === 'tls') io.err('the hub certificate is not trusted; check --hub and --ca');
      else if (err.kind === 'http' && err.status !== null && err.status < 500) {
        io.err(`the hub rejected the enrollment (${err.status}${err.code ? ` ${err.code}` : ''})`);
        return 4;
      } else io.err(`cannot reach the hub (${err.kind})`);
      return 3;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      io.err('cannot write the machine directory; run enroll as an administrator');
      return 2;
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
