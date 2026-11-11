import { execFile } from 'node:child_process';
import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';

// Windows OS helper (P2d1) bilan enroll aloqasi. Helper kaliti faqat helper'ning o'z katalogida
// (`%ProgramData%\NetSchool\helper`, faqat SYSTEM/Administrators) yaratiladi va turadi: enroll uni hech qachon
// ko'rmaydi, faqat ochiq kalit va claim proof'ini oladi (`helper-key`), claim'dan keyin hub konfiguratsiyasini
// helper'ga beradi (`set-hub`). Helper exe absolyut yo'l bilan, qat'iy argumentlar bilan, shell'siz chaqiriladi.

export interface HelperClaim {
  helperPublicKey: string;
  helperProof: string;
}

export interface HelperPort {
  // claim'dan oldin: kalitni tayyorlaydi va `NSCLAIM1\n<token>\n<helperPublicKey>` proof'ini qaytaradi.
  helperKey(token: string): Promise<HelperClaim>;
  // claim'dan keyin: device.json va hub CA'ni helper katalogiga yozdiradi, kutayotgan kalitni faollashtiradi.
  setHub(hubOrigin: string, deviceId: string): Promise<void>;
}

export class HelperError extends Error {
  readonly step: 'helper-key' | 'set-hub';
  readonly exitCode: number | null;

  constructor(step: 'helper-key' | 'set-hub', exitCode: number | null, message: string) {
    super(message);
    this.name = 'HelperError';
    this.step = step;
    this.exitCode = exitCode;
  }
}

const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(128);
const helperClaimSchema = z.strictObject({ helperPublicKey: base64url, helperProof: base64url });

// Bajarilgan jarayon natijasi. Xato matnida buyruq satri (token) bo'lmasligi kerak: faqat chiqish kodi va stderr.
export type RunFile = (
  file: string,
  args: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runFile: RunFile = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, shell: false, timeout: 120_000, maxBuffer: 1 << 16, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

export interface HelperCliOptions {
  exe: string; // paket yonidagi netschool-helper.exe, absolyut yo'l
  caFile: string | null; // admin enroll'ga bergan --ca, absolyut yo'l
  rotate: boolean; // --force: hub'da eski qurilmada turgan kalit qayta ishlatilmasin
  run?: RunFile;
}

export function helperCli(opts: HelperCliOptions): HelperPort {
  const absolute = (p: string) => isAbsolute(p) || win32.isAbsolute(p);
  if (!absolute(opts.exe)) throw new Error('the helper path must be absolute');
  if (opts.caFile !== null && !absolute(opts.caFile)) throw new Error('the CA path must be absolute');
  const run = opts.run ?? runFile;
  const call = async (step: 'helper-key' | 'set-hub', args: string[]) => {
    const res = await run(opts.exe, args);
    if (res.code !== 0) {
      const reason = res.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? '';
      throw new HelperError(
        step,
        res.code,
        `netschool-helper ${step} failed (exit ${res.code ?? 'unknown'}): ${reason}`,
      );
    }
    return res.stdout;
  };
  return {
    async helperKey(token) {
      const stdout = await call('helper-key', ['helper-key', '--token', token, ...(opts.rotate ? ['--rotate'] : [])]);
      try {
        return helperClaimSchema.parse(JSON.parse(stdout));
      } catch {
        throw new HelperError('helper-key', 0, 'netschool-helper helper-key printed an unexpected answer');
      }
    },
    async setHub(hubOrigin, deviceId) {
      await call('set-hub', [
        'set-hub',
        '--origin',
        hubOrigin,
        '--device-id',
        deviceId,
        ...(opts.caFile === null ? [] : ['--ca-file', opts.caFile]),
      ]);
    },
  };
}
