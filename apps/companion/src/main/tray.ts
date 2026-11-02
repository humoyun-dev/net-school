import { Menu, nativeImage, Tray } from 'electron';
import type { AgentStatus } from '../core/agent.ts';
import type { StringKey } from '../core/i18n.ts';

// 16x16 bir xil rangli belgi (tashqi fayl kerak emas).
const ICON =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPQz3/9nxLMMGrAqAGjBgwXAwAbHYgf6zXuvgAAAABJRU5ErkJggg==';

// Talaba chiqib keta olmasligi uchun menyuda "Chiqish" yo'q (spec §7.1: Companion majburiy komponent).
export function createTray(
  strings: Record<StringKey, string>,
  onOpenStatus: () => void,
): { update(s: AgentStatus): void } {
  let tray: Tray;
  try {
    tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${ICON}`));
  } catch {
    // Ba'zi Linux muhitlarida tray yo'q: ilova baribir ishlaydi.
    return { update: () => {} };
  }
  tray.setContextMenu(Menu.buildFromTemplate([{ label: strings.trayOpenStatus, click: onOpenStatus }]));
  tray.on('click', onOpenStatus);
  tray.setToolTip(strings.statusTitle);
  return {
    update(status) {
      const hub = {
        connecting: strings.hubConnecting,
        online: strings.hubOnline,
        offline: strings.hubOffline,
        tls_error: strings.hubTlsError,
        rejected: strings.hubRejected,
      }[status.hub];
      tray.setToolTip(`${strings.statusTitle}: ${hub}`);
    },
  };
}
