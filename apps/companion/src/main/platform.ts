import { systemPreferences } from 'electron';
import type { PlatformFacts } from '../core/capabilities.ts';
import type { HardLockFacts } from '../core/hard-lock.ts';
import { loadKoffi } from './koffi.ts';

// macOS ekran yozish ruxsati har safar qayta o'qiladi: o'quvchi ruxsat bersa capability darhol yangilanadi.
function screenAccess(): PlatformFacts['screenAccess'] {
  if (process.platform !== 'darwin') return 'unknown';
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return 'granted';
  if (status === 'not-determined') return 'not-determined';
  return 'denied'; // denied, restricted
}

export async function platformFacts(hardLock?: () => HardLockFacts): Promise<PlatformFacts> {
  const session = process.env.XDG_SESSION_TYPE;
  return {
    platform: process.platform,
    arch: process.arch,
    sessionType: process.platform === 'linux' && (session === 'wayland' || session === 'x11') ? session : null,
    screenAccess: screenAccess(),
    ...(process.platform === 'win32' && hardLock ? { hardLock: hardLock() } : {}),
  };
}

// Windows: joriy jarayon sessiyasi (web pipe nomi uchun). koffi yoki chaqiruv ishlamasa null — pipe ochilmaydi va
// `web.filter` `requires_setup` bo'lib qoladi.
export function currentSessionId(): number | null {
  if (process.platform !== 'win32') return null;
  try {
    const kernel32 = loadKoffi().load('kernel32.dll');
    const toSession = kernel32.func('bool __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32 *session)');
    const out = [0];
    return toSession(process.pid, out) ? (out[0] ?? null) : null;
  } catch {
    return null;
  }
}
