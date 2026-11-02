import { createPrivateKey, createPublicKey } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import type { DeviceIdentity } from './identity.ts';

// Mashina bo'yicha enrollment (egasining qarori, ADR 0009): `enroll` (admin) yozadi, Companion faqat o'qiydi.
export interface DeviceConfig {
  hubOrigin: string;
  deviceId: string;
  siteId: string;
  publicKey: string;
  enrolledAt: string;
}

export interface Enrollment {
  config: DeviceConfig;
  identity: DeviceIdentity;
  ca: string | null;
}

const CONFIG_FILE = 'device.json';
const KEY_FILE = 'device.key';
const CA_FILE = 'hub-ca.pem';
// P2d'gacha har OS user o'qiy oladi (ADR 0009 cheklovi): Companion oddiy user sessiyasida ishlaydi.
const DIR_MODE = 0o755;
const FILE_MODE = 0o644;

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

const configSchema = z.strictObject({
  hubOrigin: z.string().refine(isHttpsOrigin, 'hubOrigin must be a bare https origin'),
  deviceId: z.uuid(),
  siteId: z.uuid(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]+$/),
  enrolledAt: z.iso.datetime({ offset: true }),
});

export function machineDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const override = env.NETSCHOOL_COMPANION_DIR;
  if (override) return override;
  if (platform === 'win32') {
    return win32.join(env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData', 'NetSchool', 'companion');
  }
  if (platform === 'darwin') return '/Library/Application Support/NetSchool/companion';
  return '/var/lib/netschool/companion';
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// device.json yo'q → ro'yxatdan o'tmagan (null). Buzilgan fayl yoki kalit mos kelmasa — xato: Companion jimgina
// boshqa kalit bilan ishlamaydi.
export function loadEnrollment(dir: string): Enrollment | null {
  const raw = readOptional(join(dir, CONFIG_FILE));
  if (raw === null) return null;
  const config = configSchema.parse(JSON.parse(raw));
  const privateKey = createPrivateKey(readFileSync(join(dir, KEY_FILE), 'utf8'));
  const derived =
    privateKey.asymmetricKeyType === 'ed25519'
      ? createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url')
      : null;
  if (derived !== config.publicKey) throw new Error('device key does not match device.json');
  return {
    config,
    identity: { deviceId: config.deviceId, publicKey: config.publicKey, privateKey },
    ca: readOptional(join(dir, CA_FILE)),
  };
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE); // umask'dan qat'i nazar
  renameSync(tmp, file);
}

// Har fayl atomik; device.json oxirida yoziladi — u bor bo'lsa enrollment to'liq.
export function saveEnrollment(
  dir: string,
  e: { config: DeviceConfig; privateKeyPem: string; ca: string | null },
): void {
  const config = configSchema.parse(e.config);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  writeAtomic(join(dir, KEY_FILE), e.privateKeyPem);
  if (e.ca === null) rmSync(join(dir, CA_FILE), { force: true });
  else writeAtomic(join(dir, CA_FILE), e.ca);
  writeAtomic(join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}
