import { systemPreferences } from 'electron';
import type { PlatformFacts } from '../core/capabilities.ts';
import type { HardLockFacts } from '../core/hard-lock.ts';

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
