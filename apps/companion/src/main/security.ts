import type { Session, WebContents, WebPreferences } from 'electron';

// Renderer faqat ilovaning o'z sahifalarini ko'rsatadi (spec §6): Node yo'q, sandbox, ajratilgan kontekst.
// Bu fayl `electron`dan faqat tur import qiladi, shuning uchun Node'da sinaladi.
export function windowPreferences(preload: string): WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
    spellcheck: false,
    // O'quvchi devtools orqali overlay'ni chetlab o'tmasligi uchun.
    devTools: false,
  };
}

// Hech qanday ruxsat berilmaydi va tarmoqqa chiqilmaydi: faqat `file:` yuklanadi.
export function hardenSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
}

export function hardenContents(contents: WebContents): void {
  const block = (event: { preventDefault(): void }) => event.preventDefault();
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
  contents.on('will-attach-webview', block);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
