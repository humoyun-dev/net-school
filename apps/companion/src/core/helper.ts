import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
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

// `helper-key` javobi: claim maydonlari + dataRootReplaced (helper ishonchsiz `%ProgramData%\NetSchool`ni, masalan P0c
// paketinikini, eski enrollment bilan birga o'chirib qayta yaratdi). dataRootReplaced claim'ga yuborilmaydi.
export interface HelperKeyAnswer extends HelperClaim {
  dataRootReplaced?: boolean;
}

export interface HelperPort {
  // claim'dan oldin: kalitni tayyorlaydi va `NSCLAIM1\n<token>\n<helperPublicKey>` proof'ini qaytaradi.
  helperKey(token: string): Promise<HelperKeyAnswer>;
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
const helperClaimSchema = z.strictObject({
  helperPublicKey: base64url,
  helperProof: base64url,
  dataRootReplaced: z.boolean().optional(),
});

// Bajarilgan jarayon natijasi. Maxfiy qiymatlar (token, CA) faqat stdin orqali: argv jarayonlar ro'yxatida ko'rinadi.
// Xato matnida buyruq satri bo'lmasligi kerak: faqat chiqish kodi va stderr.
export type RunFile = (
  file: string,
  args: string[],
  stdin: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runFile: RunFile = (file, args, stdin) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { windowsHide: true, shell: false, timeout: 120_000, maxBuffer: 1 << 16, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.on('error', () => {}); // jarayon stdin'ni o'qimay chiqsa: natija callback'da
    child.stdin?.end(stdin);
  });

// Hub CA PEM qoidasi Go helper'dagi bilan bir xil (native/helper/internal/install `checkCA`): 1 MiB gacha, faqat
// sarlavhasiz CERTIFICATE bloklari, har biri X.509 sifatida o'qiladi, bloklar orasida va atrofida faqat bo'sh joy.
export const MAX_CA_BYTES = 1 << 20;
// Go `pem.Decode` kabi: BEGIN va END har biri o'z qatorida (END'dan oldin yangi qator majburiy), END qatoridan keyin
// shu qatorda faqat bo'sh joy; bloklar orasida faqat bo'sh joy (checkCaPem `trim`).
const CERT_BLOCK =
  /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END CERTIFICATE-----[ \t]*(?:\r?\n|$)/;

export function checkCaPem(pem: string): void {
  if (Buffer.byteLength(pem) > MAX_CA_BYTES) throw new Error('the CA file is too large');
  // Faqat ko'rinadigan ASCII va \t\r\n: JS trim() Unicode bo'shliqlarini (BOM, NBSP) ham kesadi, Go'niki esa yo'q — qoidalar farqlanmasin.
  if (/[^\t\n\r -~]/.test(pem)) throw new Error('the CA file must be plain ASCII PEM');
  let rest = pem.trim();
  let count = 0;
  while (rest.length > 0) {
    const m = CERT_BLOCK.exec(rest);
    if (!m?.[1]) throw new Error('the CA file must contain only PEM CERTIFICATE blocks');
    try {
      new X509Certificate(Buffer.from(m[1].replace(/\s+/g, ''), 'base64'));
    } catch {
      throw new Error('the CA file contains a certificate that cannot be parsed');
    }
    count++;
    rest = rest.slice(m[0].length).trim();
  }
  if (count === 0) throw new Error('the CA file has no certificate');
}

export interface HelperCliOptions {
  exe: string; // paket yonidagi netschool-helper.exe, absolyut yo'l
  ca: string | null; // admin bergan CA'ning claim'dan oldin tekshirilgan aynan o'sha matni (set-hub stdin'iga)
  rotate: boolean; // --force: hub'da eski qurilmada turgan kalit qayta ishlatilmasin
  run?: RunFile;
}

export function helperCli(opts: HelperCliOptions): HelperPort {
  const absolute = (p: string) => isAbsolute(p) || win32.isAbsolute(p);
  if (!absolute(opts.exe)) throw new Error('the helper path must be absolute');
  if (opts.ca !== null) checkCaPem(opts.ca);
  const run = opts.run ?? runFile;
  const call = async (step: 'helper-key' | 'set-hub', args: string[], stdin: string) => {
    const res = await run(opts.exe, args, stdin);
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
      // Token argv'da emas: bitta qator stdin'ga.
      const stdout = await call(
        'helper-key',
        ['helper-key', '--token-stdin', ...(opts.rotate ? ['--rotate'] : [])],
        `${token}\n`,
      );
      try {
        return helperClaimSchema.parse(JSON.parse(stdout));
      } catch {
        throw new HelperError('helper-key', 0, 'netschool-helper helper-key printed an unexpected answer');
      }
    },
    async setHub(hubOrigin, deviceId) {
      await call(
        'set-hub',
        ['set-hub', '--origin', hubOrigin, '--device-id', deviceId, ...(opts.ca === null ? [] : ['--ca-stdin'])],
        opts.ca ?? '',
      );
    },
  };
}
