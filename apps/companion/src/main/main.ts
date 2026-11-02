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

// Asosiy jarayon CommonJS bundle sifatida yig'iladi (Playwright ESM entry'ni ulay olmaydi), shuning uchun __dirname.
const here = __dirname;

async function main(): Promise<void> {
  // Bitta OS user ichida bitta nusxa; per-user holat katalogi testlar uchun almashtiriladi.
  if (process.env.NETSCHOOL_COMPANION_STATE_DIR) app.setPath('userData', process.env.NETSCHOOL_COMPANION_STATE_DIR);
  if (!app.requestSingleInstanceLock()) {
    app.quit(); // ikkinchi nusxa hech narsa qilmaydi
    return;
  }

  // Oxirgi oyna yopilganda ham ilova ishlashda davom etadi (overlay va holat oynasi vaqtincha yopiq bo'lishi mumkin).
  app.on('window-all-closed', () => {});
  app.on('second-instance', () => {});

  await app.whenReady();
  if (process.platform === 'darwin') app.dock?.hide();

  // NETSCHOOL_COMPANION_LOCALE: IT admin yoki sinov uchun tilni qo'lda belgilash (uz | ru | en).
  const text = strings[pickLocale(process.env.NETSCHOOL_COMPANION_LOCALE ?? app.getLocale())];
  const windows = new Windows({
    preload: join(here, 'preload.cjs'),
    rendererDir: join(here, 'renderer'),
    // Faqat test holat katalogi bilan birga: oddiy o'rnatishda overlay'ni yashirib bo'lmaydi.
    hidden: process.env.NETSCHOOL_COMPANION_TEST_HIDDEN === '1' && Boolean(process.env.NETSCHOOL_COMPANION_STATE_DIR),
  });
  // OS o'chirilishi yoki chiqish: oynalar yopilishiga ruxsat (aks holda ilova o'chirishni to'sib qo'yadi).
  app.on('before-quit', () => windows.allowClose());
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
    // Avval agent to'xtaydi (sikllar keshga yozishni tugatadi), keyin kesh yopiladi va chiqish davom etadi.
    let shuttingDown = false;
    app.on('before-quit', (event) => {
      if (shuttingDown) return;
      shuttingDown = true;
      event.preventDefault();
      windows.allowClose();
      void agent.stop().finally(() => {
        cache.close();
        app.quit();
      });
    });
  }

  // Bo'sh oyna ro'yxati bilan qayta faollashtirish (macOS) hech narsa ochmaydi.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.showStatus();
  });
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
