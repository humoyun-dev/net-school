// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderPanel(send: Api['send'], onClose = vi.fn()) {
  const api = { get: vi.fn(), send } as unknown as Api;
  render(
    <LocaleProvider initial="uz">
      <ApiProvider api={api}>
        <RemotePanel lessonId={id(2)} deviceId={id(3)} label="pc-01" mode="view" onClose={onClose} timer={timer} />
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
});
