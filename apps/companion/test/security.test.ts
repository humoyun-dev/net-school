import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { hardenContents, hardenSession, windowPreferences } from '../src/main/security.ts';

const RENDERER = join(import.meta.dirname, '..', 'src', 'renderer');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'";

describe('window security', () => {
  test('renderer windows are sandboxed without Node', () => {
    const prefs = windowPreferences('/app/dist/preload.cjs');
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      preload: '/app/dist/preload.cjs',
    });
    expect(prefs.nodeIntegrationInWorker).not.toBe(true);
    expect(prefs.nodeIntegrationInSubFrames).not.toBe(true);
  });

  test('every permission request and check is denied', () => {
    const handlers: Record<string, (...a: never[]) => unknown> = {};
    const session = {
      setPermissionRequestHandler: (h: never) => (handlers.request = h),
      setPermissionCheckHandler: (h: never) => (handlers.check = h),
      webRequest: { onBeforeRequest: (h: never) => (handlers.before = h) },
    };
    hardenSession(session as never);
    const callback = vi.fn();
    (handlers.request as (...a: unknown[]) => void)({}, 'media', callback);
    (handlers.request as (...a: unknown[]) => void)({}, 'notifications', callback);
    expect(callback.mock.calls).toEqual([[false], [false]]);
    expect((handlers.check as () => boolean)()).toBe(false);
  });

  test('only file urls may load; network requests are cancelled', () => {
    let before: (d: { url: string }, cb: (r: { cancel: boolean }) => void) => void = () => {};
    hardenSession({
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      webRequest: { onBeforeRequest: (h: typeof before) => (before = h) },
    } as never);
    const verdict = (url: string) => {
      const cb = vi.fn();
      before({ url }, cb);
      return cb.mock.calls[0]?.[0].cancel;
    };
    expect(verdict('file:///app/dist/renderer/status.html')).toBe(false);
    for (const url of [
      'https://evil.example/x.js',
      'http://localhost:8080/',
      'ws://hub/x',
      'ftp://x/y',
      'devtools://devtools/x',
    ]) {
      expect(verdict(url), url).toBe(true);
    }
  });

  test('navigation, new windows and webviews are blocked', () => {
    const events: Record<string, (...a: unknown[]) => void> = {};
    let openHandler: (d: { url: string }) => { action: string } = () => ({ action: 'allow' });
    hardenContents({
      on: (name: string, h: (...a: unknown[]) => void) => (events[name] = h),
      setWindowOpenHandler: (h: typeof openHandler) => (openHandler = h),
    } as never);
    for (const name of ['will-navigate', 'will-attach-webview', 'will-redirect']) {
      const event = { preventDefault: vi.fn() };
      events[name]?.(event, 'https://evil.example');
      expect(event.preventDefault, name).toHaveBeenCalledOnce();
    }
    expect(openHandler({ url: 'https://evil.example' })).toEqual({ action: 'deny' });
  });
});

describe('renderer pages', () => {
  const pages = readdirSync(RENDERER).filter((f) => f.endsWith('.html'));

  test('the three pages exist', () => {
    expect(pages.sort()).toEqual(['message.html', 'overlay.html', 'status.html']);
  });

  test('every page carries the strict CSP and no inline or remote code', () => {
    for (const page of pages) {
      const html = readFileSync(join(RENDERER, page), 'utf8');
      expect(html, page).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
      expect(html, page).not.toMatch(/<script(?![^>]*\bsrc=)/i); // inline <script> yo'q
      expect(html, page).not.toMatch(/\son[a-z]+=/i); // inline hodisa atributlari yo'q
      expect(html, page).not.toMatch(/https?:\/\//i);
    }
  });

  test('styles load nothing from the network', () => {
    const css = readFileSync(join(RENDERER, 'styles.css'), 'utf8');
    expect(css).not.toMatch(/https?:\/\/|@import/i);
  });
});
