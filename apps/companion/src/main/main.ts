import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { type AgentStatus, CompanionAgent } from '../core/agent.ts';
import { StateCache } from '../core/cache.ts';
import { systemClock } from '../core/clock.ts';
import { CommandProcessor } from '../core/commands.ts';
import { HubClient } from '../core/hub-client.ts';
import { pickLocale, strings } from '../core/i18n.ts';
import { RequestSigner } from '../core/identity.ts';
import { loadEnrollment, machineDir } from '../core/machine-store.ts';
import { OverlayController } from '../core/overlay.ts';
import { ThumbnailUploader } from '../core/thumbnails.ts';
import { ElectronFrameSource } from './capture.ts';
import { dismissArgSchema, isTrustedSender } from './ipc.ts';
import { platformFacts } from './platform.ts';
import { hardenSession } from './security.ts';
import { createTray } from './tray.ts';
import { Windows } from './windows.ts';

const here = import.meta.dirname;

// Bitta OS user ichida bitta nusxa; per-user holat katalogi testlar uchun almashtiriladi.
if (process.env.NETSCHOOL_COMPANION_STATE_DIR) app.setPath('userData', process.env.NETSCHOOL_COMPANION_STATE_DIR);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  await new Promise<never>(() => {}); // ikkinchi nusxa hech narsa qilmaydi
}

// Oxirgi oyna yopilganda ham ilova ishlashda davom etadi (overlay va holat oynasi vaqtincha yopiq bo'lishi mumkin).
app.on('window-all-closed', () => {});
app.on('second-instance', () => {});

await app.whenReady();
if (process.platform === 'darwin') app.dock?.hide();

const text = strings[pickLocale(app.getLocale())];
const windows = new Windows({ preload: join(here, 'preload.cjs'), rendererDir: join(here, 'renderer') });
hardenSession(session.defaultSession);

const trusted = (frameUrl: string | undefined) => isTrustedSender(frameUrl, windows.rendererDir);
ipcMain.handle('i18n:strings', (event) => (trusted(event.senderFrame?.url) ? text : null));
ipcMain.on('message:dismiss', (event, id: unknown) => {
  const parsed = dismissArgSchema.safeParse(id);
  if (trusted(event.senderFrame?.url) && parsed.success) windows.dismissMessage(parsed.data);
});

const enrollment = loadEnrollment(machineDir(process.platform, process.env));
const tray = createTray(text, () => windows.showStatus());

if (!enrollment) {
  // Ro'yxatdan o'tmagan kompyuter: agent ishga tushmaydi, holat oynasi sababni ko'rsatadi.
  ipcMain.handle('help:raise', () => Promise.reject(new Error('not enrolled')));
  ipcMain.handle('help:withdraw', () => Promise.reject(new Error('not enrolled')));
  windows.showStatus();
} else {
  const signer = new RequestSigner(enrollment.identity);
  const hub = new HubClient({ origin: enrollment.config.hubOrigin, ca: enrollment.ca, signer });
  const cache = StateCache.open(join(app.getPath('userData'), 'state.sqlite'));
  const overlay = new OverlayController(systemClock, cache, () => {});
  const commands = new CommandProcessor({ hub, cache, overlay, ui: { showMessage: (t) => windows.showMessage(t) } });
  const thumbnails = new ThumbnailUploader({ hub, signer, source: new ElectronFrameSource() });
  const onStatus = (status: AgentStatus) => {
    windows.update(status);
    tray.update(status);
  };
  const agent = new CompanionAgent({ hub, cache, overlay, commands, thumbnails, facts: platformFacts, onStatus });

  ipcMain.handle('help:raise', async (event) => {
    if (!trusted(event.senderFrame?.url)) throw new Error('forbidden');
    await agent.raiseHelp();
  });
  ipcMain.handle('help:withdraw', async (event) => {
    if (!trusted(event.senderFrame?.url)) throw new Error('forbidden');
    await agent.withdrawHelp();
  });

  await agent.start();
  if (process.env.NETSCHOOL_COMPANION_SHOW_STATUS === '1') windows.showStatus();
  app.on('before-quit', () => {
    void agent.stop();
    cache.close();
  });
}

// Bo'sh oyna ro'yxati bilan qayta faollashtirish (macOS) hech narsa ochmaydi.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) windows.showStatus();
});
