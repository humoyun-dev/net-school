import { useMemo } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { ApiProvider } from './api/api-context.tsx';
import { createApi } from './api/client.ts';
import { LoginPage } from './auth/login-page.tsx';
import { PasswordPage } from './auth/password-page.tsx';
import { SessionProvider, useSession } from './auth/session.tsx';
import { RoomPage } from './classroom/room-page.tsx';
import { LocaleProvider, useT } from './i18n/i18n.tsx';
import { Shell } from './layout/shell.tsx';
import { RoomsPage } from './rooms/rooms-page.tsx';

// Kirmagan foydalanuvchi login'ga, qaytish manzili bilan.
function Protected() {
  const { me, loading } = useSession();
  const location = useLocation();
  const t = useT();
  if (loading) return <p className="notice">{t('common.loading')}</p>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (me.user.mustChangePassword) return <Navigate to="/password" replace />;
  return <Outlet />;
}

function Pages() {
  const { refresh } = useSession();
  const router = useMemo(
    () =>
      createBrowserRouter([
        { path: '/login', element: <LoginPage onSignedIn={refresh} /> },
        { path: '/password', element: <PasswordPage onChanged={refresh} /> },
        {
          element: <Protected />,
          children: [
            {
              element: <Shell />,
              children: [
                { index: true, element: <Navigate to="/rooms" replace /> },
                { path: '/rooms', element: <RoomsPage /> },
                { path: '/rooms/:roomId', element: <RoomPage /> },
                { path: '*', element: <Navigate to="/rooms" replace /> },
              ],
            },
          ],
        },
      ]),
    [refresh],
  );
  return <RouterProvider router={router} />;
}

export function App() {
  const api = useMemo(
    () =>
      createApi(
        (input, init) => fetch(input, init),
        () => {
          // Sessiya tugadi: login sahifasiga, qaytish manzili bilan (to'liq qayta yuklash holatni tozalaydi).
          if (location.pathname !== '/login') {
            location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
          }
        },
        () => {
          if (location.pathname !== '/password') location.assign('/password');
        },
      ),
    [],
  );
  return (
    <LocaleProvider>
      <ApiProvider api={api}>
        <SessionProvider>
          <Pages />
        </SessionProvider>
      </ApiProvider>
    </LocaleProvider>
  );
}
