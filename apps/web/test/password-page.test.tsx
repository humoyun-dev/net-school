// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/api-context.tsx';
import { type Api, ApiFailure } from '../src/api/client.ts';
import { PasswordPage } from '../src/auth/password-page.tsx';
import { LocaleProvider } from '../src/i18n/i18n.tsx';

afterEach(cleanup);

describe('password page', () => {
  test('a wrong current password stays on the page with an inline error', async () => {
    const send = vi.fn(
      async (_m: string, _p: string, _b: unknown, _s: unknown, opts?: { noAuthRedirect?: boolean }) => {
        expect(opts?.noAuthRedirect).toBe(true);
        throw new ApiFailure(401, 'unauthenticated', 'Authentication required', null);
      },
    );
    const api = { get: vi.fn(), send } as unknown as Api;
    const router = createMemoryRouter([{ path: '/password', element: <PasswordPage onChanged={vi.fn()} /> }], {
      initialEntries: ['/password'],
    });
    render(
      <LocaleProvider initial="uz">
        <ApiProvider api={api}>
          <RouterProvider router={router} />
        </ApiProvider>
      </LocaleProvider>,
    );
    fireEvent.change(screen.getByLabelText('Joriy parol'), { target: { value: 'wrong-temp' } });
    fireEvent.change(screen.getByLabelText('Yangi parol'), { target: { value: 'a-new-long-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Saqlash' }));
    expect(await screen.findByText("Joriy parol noto'g'ri")).toBeTruthy();
    expect(router.state.location.pathname).toBe('/password');
  });
});
