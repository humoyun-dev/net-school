import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import type { AgentStatus } from '../core/agent.ts';
import { hardenContents, windowPreferences } from './security.ts';

const MESSAGE_AUTO_CLOSE_MS = 30_000;

// Companion oynalari: displey boshiga bitta overlay, xabar oynasi va holat oynasi. Hammasi sandbox'da.
export class Windows {
  readonly #preload: string;
  readonly #rendererDir: string;
  #status: AgentStatus | null = null;
  #overlays = new Map<number, BrowserWindow>();
  #statusWindow: BrowserWindow | null = null;
  readonly #messages = new Map<string, BrowserWindow>();

  constructor(opts: { preload: string; rendererDir: string }) {
    this.#preload = opts.preload;
    this.#rendererDir = opts.rendererDir;
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
        backgroundColor: '#0b0e13',
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.on('close', (event) => {
        if (this.#status?.overlay.locked) event.preventDefault();
      });
      win.once('ready-to-show', () => win.show());
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
    win.once('ready-to-show', () => win.show());
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
      this.#statusWindow.show();
      this.#statusWindow.focus();
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
      event.preventDefault();
      win.hide();
    });
    win.once('ready-to-show', () => win.show());
    this.#statusWindow = win;
  }
}
