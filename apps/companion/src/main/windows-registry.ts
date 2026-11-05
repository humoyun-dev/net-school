import { execFile } from 'node:child_process';
import type { RegistryEntry, RegistryPort } from '../core/lock-policy.ts';

const REG_TIMEOUT_MS = 5_000;

// `reg query` chiqishidan DWORD qiymatni oladi: "    DisableTaskMgr    REG_DWORD    0x1". REG_DWORD nomi lokalizatsiya qilinmaydi.
export function parseRegDword(stdout: string, name: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_DWORD\s+0x([0-9a-fA-F]+)\s*$/.exec(line);
    if (match && match[1]?.toLowerCase() === name.toLowerCase()) return Number.parseInt(match[2] ?? '', 16);
  }
  return null;
}

// reg.exe argumentlari doim qat'iy ro'yxatdan (LOCK_POLICY) keladi; foydalanuvchi matni bu yerga tushmaydi, shell ishlatilmaydi.
function reg(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { timeout: REG_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
      // reg.exe qiymat/kalit yo'q bo'lsa 1 bilan chiqadi: bu xato emas, "yo'q".
      if (typeof code === 'number') return resolve({ code, stdout });
      reject(err);
    });
  });
}

export class WindowsRegistry implements RegistryPort {
  async read(entry: RegistryEntry): Promise<number | null> {
    const { code, stdout } = await reg(['query', entry.key, '/v', entry.name]);
    return code === 0 ? parseRegDword(stdout, entry.name) : null;
  }

  async write(entry: RegistryEntry, value: number): Promise<void> {
    const { code } = await reg(['add', entry.key, '/v', entry.name, '/t', 'REG_DWORD', '/d', String(value), '/f']);
    if (code !== 0) throw new Error(`reg add ${entry.name} exited with ${code}`);
  }

  async remove(entry: RegistryEntry): Promise<void> {
    const { code } = await reg(['delete', entry.key, '/v', entry.name, '/f']);
    // 1 — qiymat allaqachon yo'q: maqsad bajarilgan.
    if (code !== 0 && code !== 1) throw new Error(`reg delete ${entry.name} exited with ${code}`);
  }
}
