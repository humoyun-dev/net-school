import type { CapabilityReport } from '@netschool/contracts';

// Qurilma haqidagi faktlar (Electron'siz): platforma, arxitektura, Linux sessiyasi va macOS ekran ruxsati.
export interface PlatformFacts {
  platform: NodeJS.Platform;
  arch: string;
  sessionType: 'x11' | 'wayland' | null;
  screenAccess: 'granted' | 'denied' | 'not-determined' | 'unknown';
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

// `remote.desktop` Companion hisobotida yo'q: uning manbai MeshAgent (ADR 0005, 0008).
export function capabilityReport(f: PlatformFacts): CapabilityReport {
  return {
    protocolVersion: 1,
    os: OS[f.platform] ?? 'other',
    architecture: f.arch,
    desktopSession: desktopSession(f),
    capabilities: {
      'classroom.message': { state: 'available' },
      // Soft overlay interfeysda ham soft sifatida ko'rsatiladi (spec §7).
      'classroom.overlay': { state: 'available', enforcement: 'soft' },
      'classroom.help': { state: 'available' },
      'classroom.thumbnails': thumbnails(f),
    },
  };
}
