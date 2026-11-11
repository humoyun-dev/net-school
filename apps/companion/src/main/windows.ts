import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BrowserWindow, screen } from 'electron';
import type { AgentStatus } from '../core/agent.ts';
import { onOverlayGone, ReloadBudget } from '../core/reload-budget.ts';
import { hardenContents, windowPreferences } from './security.ts';

const MESSAGE_AUTO_CLOSE_MS = 30_000;
// Overlay renderer'i 60 s ichida 3 martadan ko'p qayta yuklanmaydi; ortig'i kechiktiriladi (ReloadBudget).
const OVERLAY_RELOADS = { max: 3, windowMs: 60_000 };

// Companion oynalari: displey boshiga bitta overlay, xabar oynasi va holat oynasi. Hammasi sandbox'da.
export class Windows {
  readonly #preload: string;
  readonly #rendererDir: string;
  #status: AgentStatus | null = null;
  // Chiqish boshlangach (OS o'chirilmoqda/chiqilmoqda) oynalar yopilishiga to'sqinlik qilmaydi.
  #quitting = false;
  #overlays = new Map<number, BrowserWindow>();
  #statusWindow: BrowserWindow | null = null;
  readonly #messages = new Map<string, BrowserWindow>();

  // Sinov rejimi: oynalar yaratiladi va tekshiriladi, lekin ekranda ko'rsatilmaydi (ishlab chiquvchi ekranini qoplamasligi uchun).
  readonly #hidden: boolean;

  constructor(opts: { preload: string; rendererDir: string; hidden?: boolean }) {
    this.#hidden = opts.hidden ?? false;
    this.#preload = opts.preload;
    this.#rendererDir = opts.rendererDir;
  }

  #reveal(win: BrowserWindow): void {
    if (!this.#hidden) win.show();
  }

  // Chiqish (OS o'chirilishi, tizimdan chiqish): macOS `closable: false` oynani yopmaydi, shuning uchun overlay va xabar
  // oynalari yo'q qilinadi — aks holda ilova o'chirishni to'sib qo'yadi.
  allowClose(): void {
    this.#quitting = true;
    this.#hideOverlays();
    for (const [id, win] of this.#messages) {
      this.#messages.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  get rendererDir(): string {
    return this.#rendererDir;
  }

  #create(page: string, options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
    const win = new BrowserWindow({ ...options, show: false, webPreferences: windowPreferences(this.#preload) });
    hardenContents(win.webContents);
    win.setMenu(null);
    // Har yangi sahifaga joriy holat beriladi (sahifa o'zi hodisani o'tkazib yubormasligi uchun).
    win.webContents.on('did-finish-load', () => {
      if (this.#status) win.webContents.send('status:update', this.#status);
    });
    void win.loadFile(join(this.#rendererDir, page));
    return win;
  }

  update(status: AgentStatus): void {
    this.#status = status;
    for (const win of this.#all()) {
      if (!win.isDestroyed()) win.webContents.send('status:update', status);
    }
    if (status.overlay.locked) this.#showOverlays();
    else this.#hideOverlays();
  }

  #all(): BrowserWindow[] {
    return [
      ...this.#overlays.values(),
      ...this.#messages.values(),
      ...(this.#statusWindow ? [this.#statusWindow] : []),
    ];
  }

  // Yumshoq overlay: barcha displeyni qoplaydi, yopib bo'lmaydi; lease tugasa yoki unlock bo'lsa o'zi yopiladi.
  #showOverlays(): void {
    for (const display of screen.getAllDisplays()) {
      const existing = this.#overlays.get(display.id);
      if (existing && !existing.isDestroyed()) continue;
      const win = this.#create('overlay.html', {
        ...display.bounds,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        focusable: true,
        fullscreenable: false,
        enableLargerThanScreen: true,
        backgroundColor: '#0b0e13',
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setBounds(display.bounds); // macOS menyu satri ostiga ham yetishi uchun (enableLargerThanScreen)
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.on('close', (event) => {
        if (!this.#quitting && this.#status?.overlay.locked) event.preventDefault();
      });
      // O'quvchi renderer jarayonini o'ldirsa (Companion'ning o'zini helper himoyalaydi, Electron bolalarini emas),
      // oyna qoladi, lekin bo'sh: u darhol ko'rsatiladi (birinchi chizishdan oldin o'ldirilsa ready-to-show
      // kelmaydi), sahifa qayta yuklanadi va holat did-finish-load'da qayta yuboriladi. O'ldirish sikli reload'ni
      // cheksiz takrorlatmasin: 60 s ichida 3 tadan ortig'i kechiktiriladi, bitta kutilayotgan reload yetarli.
      // Sabab, `clean-exit` ham, farqlanmaydi (onOverlayGone).
      const budget = new ReloadBudget({ ...OVERLAY_RELOADS, nowMs: () => performance.now() });
      let pending = false;
      win.webContents.on('render-process-gone', () => {
        if (win.isDestroyed() || this.#quitting) return;
        const action = onOverlayGone(budget, pending);
        if (action.reveal) this.#reveal(win);
        if (action.reloadIn === null) return;
        const reload = () => {
          pending = false;
          if (!win.isDestroyed() && !this.#quitting) win.webContents.reload();
        };
        if (action.reloadIn === 0) {
          reload();
          return;
        }
        pending = true;
        setTimeout(reload, action.reloadIn).unref();
      });
      win.once('ready-to-show', () => this.#reveal(win));
      this.#overlays.set(display.id, win);
    }
  }

  #hideOverlays(): void {
    for (const [id, win] of this.#overlays) {
      this.#overlays.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  showMessage(text: string): void {
    const id = randomUUID();
    const win = this.#create('message.html', {
      width: 480,
      height: 260,
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      center: true,
      backgroundColor: '#14181f',
    });
    this.#messages.set(id, win);
    win.webContents.once('did-finish-load', () => win.webContents.send('message:show', { id, text }));
    win.once('ready-to-show', () => this.#reveal(win));
    win.once('closed', () => this.#messages.delete(id));
    setTimeout(() => this.dismissMessage(id), MESSAGE_AUTO_CLOSE_MS).unref();
  }

  dismissMessage(id: string): void {
    const win = this.#messages.get(id);
    if (win && !win.isDestroyed()) win.close();
    this.#messages.delete(id);
  }

  showStatus(): void {
    if (this.#statusWindow && !this.#statusWindow.isDestroyed()) {
      this.#reveal(this.#statusWindow);
      return;
    }
    const win = this.#create('status.html', {
      width: 380,
      height: 340,
      resizable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#14181f',
    });
    // Yopilganda yashirinadi, ilova ishlashda davom etadi (tray orqali qayta ochiladi).
    win.on('close', (event) => {
      if (this.#quitting) return;
      event.preventDefault();
      win.hide();
    });
    win.once('ready-to-show', () => this.#reveal(win));
    this.#statusWindow = win;
  }
}
