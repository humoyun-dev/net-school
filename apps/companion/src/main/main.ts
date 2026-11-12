import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { type AgentStatus, CompanionAgent } from '../core/agent.ts';
import { StateCache } from '../core/cache.ts';
import { systemClock } from '../core/clock.ts';
import { CommandProcessor } from '../core/commands.ts';
import { HardLock } from '../core/hard-lock.ts';
import { HubClient } from '../core/hub-client.ts';
import { pickLocale, strings } from '../core/i18n.ts';
import { RequestSigner } from '../core/identity.ts';
import { LockPolicy } from '../core/lock-policy.ts';
import { loadEnrollment, machineDir } from '../core/machine-store.ts';
import { OverlayController } from '../core/overlay.ts';
import { hubPolicyDeps, PolicySync, type WebPolicyPush } from '../core/policy-sync.ts';
import { ThumbnailUploader } from '../core/thumbnails.ts';
import { ElectronFrameSource } from './capture.ts';
import { dismissArgSchema, isTrustedSender } from './ipc.ts';
import { platformFacts } from './platform.ts';
import { hardenSession } from './security.ts';
import { createTray } from './tray.ts';
import { keyboardHookAvailable, WindowsKeyboardHook } from './win-keyboard-hook.ts';
import { Windows } from './windows.ts';
import { WindowsRegistry } from './windows-registry.ts';

// Asosiy jarayon CommonJS bundle sifatida yig'iladi (Playwright ESM entry'ni ulay olmaydi), shuning uchun __dirname.
const here = __dirname;
// esbuild `define` (scripts/build.mjs): faqat e2e test build'ida true.
declare const __NETSCHOOL_TEST_BUILD__: boolean;

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
    // Faqat e2e test build'ida (build vaqtidagi bayroq): oddiy build'da o'quvchi overlay'ni muhit orqali yashira olmaydi.
    hidden: __NETSCHOOL_TEST_BUILD__
      ? process.env.NETSCHOOL_COMPANION_TEST_HIDDEN === '1' && Boolean(process.env.NETSCHOOL_COMPANION_STATE_DIR)
      : false,
  });
  // OS o'chirilishi yoki chiqish: oynalar yopilishiga ruxsat (aks holda ilova o'chirishni to'sib qo'yadi).
  app.on('before-quit', () => windows.allowClose());
  hardenSession(session.defaultSession);

  const trusted = (frameUrl: string | undefined) => isTrustedSender(frameUrl, windows.rendererDir);
  // Buzilgan enrollment (JSON, kalit mos emas, huquq) yoki ochilmaydigan kesh: ilova jimgina yo'qolmaydi, sababni ko'rsatadi.
  let enrollment: ReturnType<typeof loadEnrollment> = null;
  let cache: StateCache | null = null;
  let broken = false;
  try {
    // Katalogni muhit orqali almashtirish faqat e2e test build'ida (oddiy build'da o'quvchi uni `setx` bilan bera olardi).
    enrollment = loadEnrollment(machineDir(process.platform, process.env, { allowOverride: __NETSCHOOL_TEST_BUILD__ }));
    if (enrollment) cache = StateCache.open(join(app.getPath('userData'), 'state.sqlite'));
  } catch (err) {
    broken = true;
    enrollment = null;
    console.error('companion cannot start:', err);
  }
  const pageText = broken ? { ...text, notEnrolled: text.enrollmentBroken } : text;
  ipcMain.handle('i18n:strings', (event) => (trusted(event.senderFrame?.url) ? pageText : null));
  ipcMain.on('message:dismiss', (event, id: unknown) => {
    const parsed = dismissArgSchema.safeParse(id);
    if (trusted(event.senderFrame?.url) && parsed.success) windows.dismissMessage(parsed.data);
  });

  const tray = createTray(text, () => windows.showStatus());

  if (!enrollment || !cache) {
    // Ro'yxatdan o'tmagan kompyuter: agent ishga tushmaydi, holat oynasi sababni ko'rsatadi.
    ipcMain.handle('help:raise', () => Promise.reject(new Error('not enrolled')));
    ipcMain.handle('help:withdraw', () => Promise.reject(new Error('not enrolled')));
    windows.showStatus();
  } else {
    const signer = new RequestSigner(enrollment.identity);
    const hub = new HubClient({ origin: enrollment.config.hubOrigin, ca: enrollment.ca, signer });
    // Kuchli bloklash faqat Windows'da (ADR 0012). Hook yuklanmasa (koffi yo'q) yoki o'rnatilmasa, overlay yumshoq qoladi
    // va capability sababini aytadi; yolg'on «bloklangan» da'vo qilinmaydi.
    const hardLock =
      process.platform === 'win32'
        ? new HardLock({
            policy: new LockPolicy(new WindowsRegistry(), {
              load: () => cache.loadPolicyJournal(),
              save: (entries) => cache.savePolicyJournal(entries),
            }),
            hook: new WindowsKeyboardHook(),
            onError: (reason, err) => console.error(`hard lock: ${reason}`, err),
          })
        : null;
    const hookReady = hardLock !== null && keyboardHookAvailable();
    const hardLockFacts = () =>
      hookReady ? hardLock.facts() : { enforced: false, reason: 'hook_unavailable' as const };
    const overlay = new OverlayController(systemClock, cache, (view) => {
      void hardLock?.set(view.locked);
    });
    const commands = new CommandProcessor({ hub, cache, overlay, ui: { showMessage: (t) => windows.showMessage(t) } });
    const thumbnails = new ThumbnailUploader({ hub, signer, source: new ElectronFrameSource() });
    const onStatus = (status: AgentStatus) => {
      windows.update(status);
      tray.update(status);
    };
    // P2c: siyosat; web qoidalari brauzer extension'iga web pipe orqali beriladi (faqat Windows).
    const webListeners = new Set<(push: WebPolicyPush) => void>();
    const policy = new PolicySync(
      hubPolicyDeps(hub, cache, systemClock, (push) => {
        for (const fn of webListeners) fn(push);
      }),
    );
    const agent = new CompanionAgent({
      hub,
      cache,
      overlay,
      commands,
      thumbnails,
      policy,
      facts: async () => ({
        ...(await platformFacts(hardLockFacts)),
        ...(process.platform === 'win32' ? { webFilter: policy.webFilterState() } : {}),
      }),
      enforcement: () => (hookReady && overlay.view().locked && hardLock.facts().enforced ? 'hard' : 'soft'),
      onStatus,
    });

    ipcMain.handle('help:raise', async (event) => {
      if (!trusted(event.senderFrame?.url)) throw new Error('forbidden');
      await agent.raiseHelp();
    });
    ipcMain.handle('help:withdraw', async (event) => {
      if (!trusted(event.senderFrame?.url)) throw new Error('forbidden');
      await agent.withdrawHelp();
    });

    // Oldingi ishga tushishdan qolgan siyosat qaytariladi; lock bo'lsa overlay tiklanishi uni qayta qo'llaydi.
    await hardLock?.start();
    const restoreTimer = hardLock ? setInterval(() => void hardLock.reconcile(), 30_000) : null; // yo'qolgan hook va qolib ketgan siyosat
    restoreTimer?.unref();
    await agent.start();
    if (process.env.NETSCHOOL_COMPANION_SHOW_STATUS === '1') windows.showStatus();
    // Avval agent to'xtaydi (sikllar keshga yozishni tugatadi), keyin kesh yopiladi va chiqish davom etadi.
    let shuttingDown = false;
    app.on('before-quit', (event) => {
      if (shuttingDown) return;
      shuttingDown = true;
      event.preventDefault();
      windows.allowClose();
      void agent.stop().finally(async () => {
        if (restoreTimer) clearInterval(restoreTimer);
        await hardLock?.dispose();
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
