import type { CapabilityReport } from '@netschool/contracts';
import type { HardLockFacts } from './hard-lock.ts';

// Qurilma haqidagi faktlar (Electron'siz): platforma, arxitektura, Linux sessiyasi va macOS ekran ruxsati.
export interface PlatformFacts {
  platform: NodeJS.Platform;
  arch: string;
  sessionType: 'x11' | 'wayland' | null;
  screenAccess: 'granted' | 'denied' | 'not-determined' | 'unknown';
  // Faqat Windows: kuchli bloklash (klaviatura hook + siyosat) holati. Berilmasa overlay yumshoq hisoblanadi.
  hardLock?: HardLockFacts;
  // P2c: NetSchool brauzer extension'i so'nggi 60 s ichida ulanganmi. Berilmasa `web.filter` hisobotda yo'q.
  webFilter?: 'available' | 'requires_setup';
}

type Capabilities = CapabilityReport['capabilities'];

const OS: Partial<Record<NodeJS.Platform, CapabilityReport['os']>> = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
};

function desktopSession(f: PlatformFacts): CapabilityReport['desktopSession'] {
  if (f.platform === 'win32') return 'windows';
  if (f.platform === 'darwin') return 'macos';
  if (f.platform === 'linux') return f.sessionType;
  return null;
}

// Miniatura imkoniyati: macOS'da ekran yozish ruxsati bo'lmaguncha `requires_permission`; Wayland'da sertifikatlangan
// capture yo'li yo'q (P0c) — `unsupported`. Bo'sh kadr hech qachon yuborilmaydi (spec §7, §15.1).
function thumbnails(f: PlatformFacts): Capabilities[string] {
  if (f.platform === 'darwin' && f.screenAccess !== 'granted') {
    return { state: 'requires_permission', provider: 'macos_screen_recording' };
  }
  if (f.platform === 'linux' && f.sessionType === 'wayland') {
    return { state: 'unsupported', reason: 'wayland_not_certified' };
  }
  return { state: 'available' };
}

// Overlay darajasi (ADR 0012): kuchli bloklash faqat Windows'da va hook bilan siyosat ikkalasi ishlasa "hard".
// Biri ishlamasa yumshoq bloklash baribir ishlaydi: holat `available` qoladi (hub `degraded`ni `unsupported` deb hisoblab,
// lock buyrug'ini rad etardi), daraja `soft` va sabab bilan. Yolg'on "hard" da'vo qilinmaydi (spec §7).
function overlay(f: PlatformFacts): Capabilities[string] {
  if (f.platform !== 'win32' || !f.hardLock) return { state: 'available', enforcement: 'soft' };
  if (f.hardLock.enforced) return { state: 'available', enforcement: 'hard' };
  return { state: 'available', enforcement: 'soft', reason: f.hardLock.reason ?? 'hard_lock_unavailable' };
}

// `remote.desktop` Companion hisobotida yo'q: uning manbai MeshAgent (ADR 0005, 0008).
export function capabilityReport(f: PlatformFacts): CapabilityReport {
  return {
    protocolVersion: 1,
    os: OS[f.platform] ?? 'other',
    architecture: f.arch,
    desktopSession: desktopSession(f),
    capabilities: {
      'classroom.message': { state: 'available' },
      'classroom.overlay': overlay(f),
      'classroom.help': { state: 'available' },
      'classroom.thumbnails': thumbnails(f),
      ...(f.webFilter
        ? {
            'web.filter': {
              state: f.webFilter,
              provider: 'managed_extension',
              ...(f.webFilter === 'requires_setup' ? { reason: 'extension_missing' } : {}),
            },
          }
        : {}),
    },
  };
}
