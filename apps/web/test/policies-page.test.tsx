// @vitest-environment jsdom
import type { MeResponse } from '@netschool/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/api-context.tsx';
import { type Api, ApiFailure } from '../src/api/client.ts';
import { SessionContextForTest } from '../src/auth/session.tsx';
import { LocaleProvider } from '../src/i18n/i18n.tsx';
import { PoliciesPage } from '../src/policies/policies-page.tsx';

afterEach(cleanup);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(2);
const AT = '2026-11-12T10:00:00.000Z';
const orgAdmin: MeResponse = {
  user: { id: id(4), username: 'a', displayName: 'Admin', mustChangePassword: false },
  organizationId: id(9),
  assignments: [{ role: 'school_admin', siteId: null }],
  roomIds: [],
};
const version = (v: number, document: unknown, over: Record<string, unknown> = {}) => ({
  id: id(100 + v),
  layer: 'baseline',
  siteId: null,
  lessonId: null,
  version: v,
  document,
  contentHash: 'h',
  createdBy: id(4),
  createdAt: AT,
  restoredFrom: null,
  ...over,
});
const effective = {
  web: { blocked: ['bad.com'] },
  browser: { managed: true, incognito: 'allowed', devTools: 'allowed' },
  os: { standardUser: false, blockAppInstall: false, lockWallpaper: false },
};
const v1 = version(1, { schemaVersion: 1, web: { blocked: ['bad.com'] }, browser: { managed: true } });

function setup(
  h: {
    put?: (body: unknown, headers: Record<string, string>) => unknown;
    current?: unknown;
    versions?: unknown[];
  } = {},
) {
  const sent: { method: string; path: string; body: unknown; headers?: Record<string, string> }[] = [];
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === '/api/v1/sites') return { sites: [{ id: SITE, name: 'Bosh bino' }] };
      if (path === '/api/v1/policies/baseline') return { current: h.current ?? v1, effective };
      if (path === '/api/v1/policies/baseline/versions') return { versions: h.versions ?? [v1] };
      throw new Error(`unexpected GET ${path}`);
    }),
    send: vi.fn(
      async (method: string, path: string, body: unknown, _s: unknown, opts?: { headers?: Record<string, string> }) => {
        sent.push({ method, path, body, headers: opts?.headers });
        if (method === 'PUT' && path === '/api/v1/policies/baseline')
          return h.put?.(body, opts?.headers ?? {}) ?? version(2, body);
        if (path.endsWith('/restore')) return version(2, v1.document, { restoredFrom: v1.id });
        return null;
      },
    ),
  } as unknown as Api;
  const router = createMemoryRouter([{ path: '/policies', element: <PoliciesPage /> }], {
    initialEntries: ['/policies'],
  });
  render(
    <LocaleProvider initial="uz">
      <ApiProvider api={api}>
        <SessionContextForTest me={orgAdmin}>
          <RouterProvider router={router} />
        </SessionContextForTest>
      </ApiProvider>
    </LocaleProvider>,
  );
  return { sent };
}

describe('policies page', () => {
  test('saves baseline with If-Match and shows conflict message on 409', async () => {
    let conflict = false;
    const { sent } = setup({
      put: () => {
        if (conflict) throw new ApiFailure(409, 'conflict', 'Conflict', null);
        return version(2, {});
      },
    });
    const box = (await screen.findByLabelText('Bloklangan saytlar')) as HTMLTextAreaElement;
    expect(box.value).toBe('bad.com');
    fireEvent.change(box, { target: { value: 'bad.com\nGame.com' } });
    fireEvent.click(screen.getByLabelText("Incognito/InPrivate rejimini o'chirish"));
    fireEvent.click(screen.getByRole('button', { name: 'Saqlash' }));
    await waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true));
    const put = sent.find((s) => s.method === 'PUT');
    expect(put?.headers).toEqual({ 'if-match': '1' });
    expect(put?.body).toEqual({
      schemaVersion: 1,
      web: { blocked: ['bad.com', 'game.com'] },
      browser: { managed: true, incognito: 'disabled', devTools: 'allowed' },
      os: { standardUser: false, blockAppInstall: false, lockWallpaper: false },
    });
    expect(await screen.findByText('Saqlandi: versiya 2')).toBeTruthy();
    conflict = true;
    fireEvent.click(screen.getByRole('button', { name: 'Saqlash' }));
    expect(await screen.findByText("Boshqa admin siyosatni o'zgartirdi. Sahifani qayta yuklang.")).toBeTruthy();
  });

  test('invalid pattern line shows validation error before saving', async () => {
    const { sent } = setup();
    const box = await screen.findByLabelText('Bloklangan saytlar');
    fireEvent.change(box, { target: { value: 'ok.com\nexa(mple).com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Saqlash' }));
    expect(await screen.findByText("Noto'g'ri sayt: exa(mple).com")).toBeTruthy();
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(0);
  });

  test('restore posts to the version endpoint', async () => {
    const v2 = version(2, { schemaVersion: 1 });
    const { sent } = setup({ current: v2, versions: [v2, v1] });
    fireEvent.click(await screen.findByRole('button', { name: 'Tiklash v1' }));
    await waitFor(() => expect(sent.some((s) => s.path.endsWith('/restore'))).toBe(true));
    const post = sent.find((s) => s.path.endsWith('/restore'));
    expect(post).toMatchObject({ method: 'POST', path: `/api/v1/policies/baseline/versions/${v1.id}/restore` });
    expect(post?.headers).toEqual({ 'if-match': '2' });
    expect(screen.queryByRole('button', { name: 'Tiklash v2' })).toBeNull();
  });
});
