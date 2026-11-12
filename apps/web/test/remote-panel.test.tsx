// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/api-context.tsx';
import { type Api, ApiFailure } from '../src/api/client.ts';
import { RemotePanel } from '../src/classroom/remote-panel.tsx';
import { LocaleProvider } from '../src/i18n/i18n.tsx';

afterEach(cleanup);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-02T10:00:00.000Z';
const session = {
  id: id(1),
  lessonId: id(2),
  deviceId: id(3),
  actorUserId: id(4),
  mode: 'view',
  status: 'active',
  openedAt: AT,
  expiresAt: AT,
  closedAt: null,
  closeReason: null,
  lease: null,
};
const timer = () => ({ start: vi.fn(), stop: vi.fn() });

function renderPanel(send: Api['send'], onClose = vi.fn(), mode: 'view' | 'control' = 'view') {
  const api = { get: vi.fn(), send } as unknown as Api;
  render(
    <LocaleProvider initial="uz">
      <ApiProvider api={api}>
        <RemotePanel lessonId={id(2)} deviceId={id(3)} label="pc-01" mode={mode} onClose={onClose} timer={timer} />
      </ApiProvider>
    </LocaleProvider>,
  );
  return onClose;
}

describe('remote panel', () => {
  test('the viewer opens in a sandboxed iframe and closing deletes the session', async () => {
    const calls: string[] = [];
    const send = vi.fn(async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (path.endsWith('/remote-sessions')) return session;
      if (path.endsWith('/ticket')) return { url: 'https://hub:8444/rs/redeem?ticket=t1', expiresAt: AT };
      return null;
    });
    const onClose = renderPanel(send as unknown as Api['send']);
    const frame = (await screen.findByTitle('pc-01')) as HTMLIFrameElement;
    expect(frame.src).toBe('https://hub:8444/rs/redeem?ticket=t1');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-pointer-lock');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    fireEvent.click(screen.getByRole('button', { name: 'Yopish' }));
    expect(onClose).toHaveBeenCalled();
    cleanup();
    await waitFor(() => expect(calls).toContain(`DELETE /api/v1/remote-sessions/${id(1)}`));
  });

  test('control_busy is explained', async () => {
    const send = vi.fn(async () => {
      throw new ApiFailure(409, 'control_busy', 'busy', null);
    });
    renderPanel(send as unknown as Api['send']);
    expect(await screen.findByText('Kompyuterni boshqa foydalanuvchi boshqaryapti')).toBeTruthy();
  });

  // Gateway ko'prigi (viewer-embed) iframe ichidan holat yuboradi; panel faqat shu iframe va gateway origin'ini tinglaydi.
  test('the viewer bridge drives the status, reconnect and Ctrl+Alt+Del', async () => {
    const send = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/remote-sessions')) return { ...session, mode: 'control' };
      if (path.endsWith('/ticket')) return { url: 'https://hub:8444/rs/redeem?ticket=t1', expiresAt: AT };
      return null;
    });
    renderPanel(send as unknown as Api['send'], vi.fn(), 'control');
    const frame = (await screen.findByTitle('pc-01')) as HTMLIFrameElement;
    const inner = frame.contentWindow as Window;
    const toInner = vi.spyOn(inner, 'postMessage').mockImplementation(() => {});
    const bridge = (state: string, origin = 'https://hub:8444', source: Window = inner) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { source, origin, data: { source: 'netschool-viewer', state } }),
        );
      });

    bridge('disconnected', 'https://evil.example');
    expect(screen.queryByRole('button', { name: 'Qayta ulanish' })).toBeNull();
    bridge('disconnected');
    expect(screen.getByText('Ulanish uzildi')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Qayta ulanish' }));
    expect(toInner).toHaveBeenCalledWith({ target: 'netschool-viewer', command: 'connect' }, 'https://hub:8444');

    expect(screen.queryByRole('button', { name: 'Maxsus tugmalar' })).toBeNull();
    bridge('connected');
    expect(screen.getByText('Ulandi')).toBeTruthy();
    // Boshqarish rejimida ulangan zahoti klaviatura fokusi ekranga beriladi (o'qituvchi bosmasdan yoza oladi).
    await waitFor(() => expect(document.activeElement).toBe(frame));
    expect(toInner).toHaveBeenCalledWith({ target: 'netschool-viewer', command: 'focus' }, 'https://hub:8444');
    // Mac'da yo'q yoki brauzer ushlaydigan kombinatsiyalar menyudan yuboriladi.
    const menu = () => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Maxsus tugmalar' }), { key: 'Enter' });
    };
    menu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ctrl+Alt+Del' }));
    expect(toInner).toHaveBeenLastCalledWith({ target: 'netschool-viewer', command: 'cad' }, 'https://hub:8444');
    menu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Win\+L/ }));
    expect(toInner).toHaveBeenLastCalledWith(
      { target: 'netschool-viewer', command: 'keys', combo: 'lock' },
      'https://hub:8444',
    );
    menu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Win\+T/ }));
    expect(toInner).toHaveBeenLastCalledWith(
      { target: 'netschool-viewer', command: 'keys', combo: 'taskbar' },
      'https://hub:8444',
    );
  });

  test('view mode has no special keys', async () => {
    const send = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/remote-sessions')) return session;
      if (path.endsWith('/ticket')) return { url: 'https://hub:8444/rs/redeem?ticket=t1', expiresAt: AT };
      return null;
    });
    renderPanel(send as unknown as Api['send']);
    const frame = (await screen.findByTitle('pc-01')) as HTMLIFrameElement;
    // Tinglovchi effektda ulanadi va iframe contentWindow'i yuklanishda almashishi mumkin: holat qabul
    // qilinmaguncha xabar qayta yuboriladi (CI'da sekin muhitda poyga bo'lgan).
    await waitFor(() => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            origin: 'https://hub:8444',
            data: { source: 'netschool-viewer', state: 'connected' },
          }),
        );
      });
      expect(screen.getByText('Ulandi')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Maxsus tugmalar' })).toBeNull();
  });

  // Mac'da Cmd+E/Cmd+L brauzerda qolib ketdi: to'liq ekran + Keyboard Lock bilan klaviatura butunlay Windows'ga.
  test('immersive mode goes fullscreen and locks the keyboard until it is left', async () => {
    const send = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/remote-sessions')) return { ...session, mode: 'control' };
      if (path.endsWith('/ticket')) return { url: 'https://hub:8444/rs/redeem?ticket=t1', expiresAt: AT };
      return null;
    });
    let fullscreen: Element | null = null;
    const requestFullscreen = vi.fn(async function (this: Element) {
      fullscreen = this;
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    const lock = vi.fn(async () => {});
    const unlock = vi.fn();
    Object.defineProperty(navigator, 'keyboard', { configurable: true, value: { lock, unlock } });

    renderPanel(send as unknown as Api['send'], vi.fn(), 'control');
    const frame = (await screen.findByTitle('pc-01')) as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          origin: 'https://hub:8444',
          data: { source: 'netschool-viewer', state: 'connected' },
        }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: "To'liq ekran" }));
    await waitFor(() => expect(lock).toHaveBeenCalled());
    expect(requestFullscreen).toHaveBeenCalled();
    expect((fullscreen as Element | null)?.classList.contains('remote-panel')).toBe(true);
    // Menyu to'liq ekran elementining ichida chiziladi (aks holda to'liq ekranda ko'rinmaydi).
    fireEvent.keyDown(screen.getByRole('button', { name: 'Maxsus tugmalar' }), { key: 'Enter' });
    const item = await screen.findByRole('menuitem', { name: /Win\+E/ });
    expect((fullscreen as Element | null)?.contains(item)).toBe(true);
    // Esc ni bosib turish yoki brauzer to'liq ekrandan chiqarsa — klaviatura qo'yib yuboriladi.
    fullscreen = null;
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(unlock).toHaveBeenCalled();
  });
});
