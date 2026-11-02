// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/api-context.tsx';
import { type Api, ApiFailure } from '../src/api/client.ts';
import { LoginPage } from '../src/auth/login-page.tsx';
import { LocaleProvider } from '../src/i18n/i18n.tsx';

afterEach(cleanup);

function renderLogin(api: Api, onSignedIn = vi.fn(), entry = '/login?next=%2Frooms%2Fr1') {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage onSignedIn={onSignedIn} /> },
      { path: '/rooms/:id', element: <p>room page</p> },
      { path: '/', element: <p>home</p> },
    ],
    { initialEntries: [entry] },
  );
  render(
    <LocaleProvider initial="uz">
      <ApiProvider api={api}>
        <RouterProvider router={router} />
      </ApiProvider>
    </LocaleProvider>,
  );
  return { router, onSignedIn };
}

const fakeApi = (send: Api['send']): Api => ({ get: vi.fn(), send }) as unknown as Api;

describe('login page', () => {
  test('login page submits credentials and returns to the saved page', async () => {
    const send = vi.fn(async () => ({ user: { id: 'u', username: 't', displayName: 'T', mustChangePassword: false } }));
    const { onSignedIn } = renderLogin(fakeApi(send as unknown as Api['send']));
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'teacher1' } });
    fireEvent.change(screen.getByLabelText('Parol'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirish' }));
    await waitFor(() => expect(screen.getByText('room page')).toBeTruthy());
    expect(send).toHaveBeenCalledWith(
      'POST',
      '/api/v1/auth/login',
      { username: 'teacher1', password: 'secret-password' },
      expect.anything(),
    );
    expect(onSignedIn).toHaveBeenCalled();
  });

  test('login page shows the translated error', async () => {
    const send = vi.fn(async () => {
      throw new ApiFailure(401, 'unauthenticated', 'Authentication required', 'corr-1');
    });
    renderLogin(fakeApi(send as unknown as Api['send']));
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'teacher1' } });
    fireEvent.change(screen.getByLabelText('Parol'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirish' }));
    expect(await screen.findByText("Login yoki parol noto'g'ri")).toBeTruthy();
  });

  test('an external next path is ignored', async () => {
    const send = vi.fn(async () => ({ user: { id: 'u', username: 't', displayName: 'T', mustChangePassword: false } }));
    const { router } = renderLogin(
      fakeApi(send as unknown as Api['send']),
      vi.fn(),
      '/login?next=https%3A%2F%2Fevil.example',
    );
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'teacher1' } });
    fireEvent.change(screen.getByLabelText('Parol'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirish' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
