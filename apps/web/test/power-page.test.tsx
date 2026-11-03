// @vitest-environment jsdom
import type { MeResponse, PowerAction } from '@netschool/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/api-context.tsx';
import { type Api, ApiFailure } from '../src/api/client.ts';
import { SessionContextForTest } from '../src/auth/session.tsx';
import { LocaleProvider } from '../src/i18n/i18n.tsx';
import { PowerPage } from '../src/power/power-page.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(2);
const AT = '2026-11-02T10:00:00.000Z';
const orgAdmin: MeResponse = {
  user: { id: id(4), username: 'a', displayName: 'Admin', mustChangePassword: false },
  organizationId: id(9),
  assignments: [{ role: 'school_admin', siteId: null }],
  roomIds: [],
};
const siteIt: MeResponse = { ...orgAdmin, assignments: [{ role: 'it_support', siteId: SITE }] };
const summary = (over: Partial<PowerAction['summary']> = {}) => ({
  pending: 0,
  sent: 0,
  succeeded: 0,
  failed: 0,
  unknown: 0,
  cancelled: 0,
  ...over,
});
const action = (over: Partial<PowerAction> = {}): PowerAction => ({
  id: id(50),
  type: 'shutdown',
  scope: { kind: 'sites', siteIds: [SITE] },
  status: 'running',
  runAt: AT,
  scheduleId: null,
  requestedBy: id(4),
  createdAt: AT,
  completedAt: null,
  summary: summary({ sent: 2 }),
  ...over,
});

interface Handlers {
  preview?: () => unknown;
  create?: (body: unknown) => unknown;
  detail?: () => unknown;
  actions?: PowerAction[];
}

function setup(me: MeResponse, h: Handlers = {}) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === '/api/v1/sites') return { sites: [{ id: SITE, name: 'Bosh bino' }] };
      if (path === `/api/v1/sites/${SITE}/rooms`) return { rooms: [{ id: id(3), siteId: SITE, name: '101' }] };
      if (path.startsWith('/api/v1/power-actions?')) return { actions: h.actions ?? [] };
      if (path.startsWith('/api/v1/power-actions/')) return h.detail?.() ?? action();
      if (path === '/api/v1/power-schedules') return { schedules: [] };
      throw new Error(`unexpected GET ${path}`);
    }),
    send: vi.fn(async (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      if (path === '/api/v1/power-actions/preview')
        return h.preview?.() ?? { deviceCount: 12, unbound: 1, agentOnline: 9, agentOffline: 2 };
      if (path === '/api/v1/power-actions') return h.create?.(body) ?? action();
      if (path === '/api/v1/power-schedules') return body;
      return null;
    }),
  } as unknown as Api;
  const router = createMemoryRouter([{ path: '/power', element: <PowerPage /> }], { initialEntries: ['/power'] });
  render(
    <LocaleProvider initial="uz">
      <ApiProvider api={api}>
        <SessionContextForTest me={me}>
          <RouterProvider router={router} />
        </SessionContextForTest>
      </ApiProvider>
    </LocaleProvider>,
  );
  return { sent };
}

async function chooseSite() {
  fireEvent.click(await screen.findByLabelText('Binolar'));
  fireEvent.click(await screen.findByLabelText('Bosh bino'));
}

describe('power page', () => {
  test('confirm is enabled only when the typed count matches the preview', async () => {
    const { sent } = setup(orgAdmin);
    await chooseSite();
    fireEvent.click(screen.getByRole('button', { name: 'Davom etish' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/12/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Tasdiqlash' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Qurilmalar sonini yozing'), { target: { value: '11' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Qurilmalar sonini yozing'), { target: { value: '12' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(sent.some((s) => s.path === '/api/v1/power-actions')).toBe(true));
    expect(sent.find((s) => s.path === '/api/v1/power-actions')?.body).toEqual({
      type: 'shutdown',
      scope: { kind: 'sites', siteIds: [SITE] },
      confirmDeviceCount: 12,
    });
  });

  test('a confirmation_required reply refreshes the preview', async () => {
    let count = 12;
    const { sent } = setup(orgAdmin, {
      preview: () => ({ deviceCount: count, unbound: 0, agentOnline: null, agentOffline: null }),
      create: () => {
        count = 13;
        throw new ApiFailure(409, 'confirmation_required', 'x', null);
      },
    });
    await chooseSite();
    fireEvent.click(screen.getByRole('button', { name: 'Davom etish' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Qurilmalar sonini yozing'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tasdiqlash' }));
    await waitFor(() => expect(sent.filter((s) => s.path === '/api/v1/power-actions/preview')).toHaveLength(2));
    expect(await within(dialog).findByText(/13/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Tasdiqlash' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('MeshCentral javob bermadi')).toBeTruthy();
  });

  test('organization scope is offered only to an org admin', async () => {
    setup(siteIt);
    await screen.findByLabelText('Binolar');
    expect(screen.queryByLabelText('Butun universitet')).toBeNull();
    cleanup();
    setup(orgAdmin);
    expect(await screen.findByLabelText('Butun universitet')).toBeTruthy();
  });

  test('a running action refreshes until completed and shows per-device reasons', async () => {
    let calls = 0;
    setup(orgAdmin, {
      actions: [action()],
      detail: () => {
        calls += 1;
        const done = calls >= 2;
        return action({
          status: done ? 'completed' : 'running',
          summary: summary(done ? { succeeded: 1, failed: 1 } : { sent: 2 }),
          targets: [
            {
              deviceId: id(10),
              hostname: 'pc-01',
              siteId: SITE,
              roomId: null,
              status: done ? 'succeeded' : 'sent',
              reason: null,
              sentAt: AT,
              forcedAt: done ? AT : null,
              finishedAt: null,
            },
            {
              deviceId: id(11),
              hostname: 'pc-02',
              siteId: SITE,
              roomId: null,
              status: done ? 'failed' : 'sent',
              reason: done ? 'device_offline' : null,
              sentAt: AT,
              forcedAt: null,
              finishedAt: null,
            },
          ],
        });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /O'chirish/ }));
    expect(await screen.findByText('pc-02')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Kompyuter tarmoqda emas edi')).toBeTruthy(), { timeout: 4_000 });
    // Yumshoq o'chirish to'silib, majburan bajarilgan kompyuter alohida belgilanadi.
    expect(screen.getAllByText('Majburan')).toHaveLength(1);
    expect(screen.getByText("Dastur to'sdi, 60 s dan keyin majburan bajarildi")).toBeTruthy();
    const after = calls;
    await act(() => new Promise((r) => setTimeout(r, 2_500)));
    expect(calls).toBe(after);
  });

  test('creating a schedule sends days, time and the browser timezone', async () => {
    const { sent } = setup(orgAdmin);
    fireEvent.click(await screen.findByRole('tab', { name: 'Jadvallar' }));
    await chooseSite();
    for (const day of ['Du', 'Se', 'Ch']) fireEvent.click(screen.getByLabelText(day));
    fireEvent.change(screen.getByLabelText('Vaqt'), { target: { value: '19:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Davom etish' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Qurilmalar sonini yozing'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tasdiqlash' }));
    await waitFor(() => expect(sent.some((s) => s.path === '/api/v1/power-schedules')).toBe(true));
    expect(sent.find((s) => s.path === '/api/v1/power-schedules')?.body).toEqual({
      type: 'shutdown',
      scope: { kind: 'sites', siteIds: [SITE] },
      rule: { daysOfWeek: [1, 2, 3], timeOfDay: '19:30', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      confirmDeviceCount: 12,
    });
  });
});
