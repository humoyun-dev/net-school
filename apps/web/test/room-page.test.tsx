// @vitest-environment jsdom
import type { Device, Lesson } from '@netschool/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/api-context.tsx';
import type { Api } from '../src/api/client.ts';
import { SessionContextForTest } from '../src/auth/session.tsx';
import { RoomPage } from '../src/classroom/room-page.tsx';
import { LocaleProvider } from '../src/i18n/i18n.tsx';

afterEach(cleanup);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOM = id(3);
const TEACHER = id(4);
const AT = '2026-11-02T10:00:00.000Z';
const device = (n: number, hostname: string): Device => ({
  id: id(n),
  siteId: id(2),
  roomId: ROOM,
  hostname,
  enrolledAt: AT,
  companion: { presence: 'online', lastHeartbeatAt: AT },
  agent: 'online',
  capabilities: null,
});
const lesson: Lesson = {
  id: id(1),
  siteId: id(2),
  roomId: ROOM,
  teacherUserId: TEACHER,
  title: null,
  status: 'active',
  startedAt: AT,
  scheduledEndAt: AT,
  endedAt: null,
  endReason: null,
  deviceIds: [id(10), id(11)],
};
const me = {
  user: { id: TEACHER, username: 't', displayName: 'T', mustChangePassword: false },
  organizationId: id(9),
  assignments: [{ role: 'teacher' as const, siteId: id(2) }],
  roomIds: [ROOM],
};

function fakeApi(opts: { activeLesson: Lesson | null }) {
  let current = opts.activeLesson;
  const sent: { method: string; path: string; body: unknown; key?: string }[] = [];
  const api = {
    get: vi.fn(async (path: string, _schema: unknown, signal?: AbortSignal) => {
      if (path.endsWith('/devices')) return { devices: [device(10, 'pc-01'), device(11, 'pc-02')] };
      if (path.startsWith('/api/v1/events')) {
        if (!path.includes('after=')) {
          return {
            cursor: '1',
            resync: true,
            snapshot: { lesson: current, commands: [], remoteSessions: [], helpRequests: [] },
            events: [],
          };
        }
        // Long-poll: hech narsa kelmaydi, sahifa yopilganda bekor bo'ladi.
        return new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      if (path.endsWith('/lessons/active')) return { lesson: current };
      throw new Error(`unexpected GET ${path}`);
    }),
    send: vi.fn(
      async (method: string, path: string, body: unknown, _schema: unknown, o?: { idempotencyKey?: string }) => {
        sent.push({ method, path, body, key: o?.idempotencyKey });
        if (path === `/api/v1/rooms/${ROOM}/lessons`) {
          current = lesson;
          return lesson;
        }
        if (path.endsWith('/commands')) {
          return {
            id: id(20),
            lessonId: lesson.id,
            type: 'message.show',
            sequence: '1',
            issuedAt: AT,
            expiresAt: AT,
            targets: [],
            summary: {},
          };
        }
        return null;
      },
    ),
  };
  return { api: api as unknown as Api, sent };
}

function renderRoom(api: Api, who = me) {
  const router = createMemoryRouter(
    [{ path: '/rooms/:roomId', element: <RoomPage createFeed={() => ({ close() {} })} /> }],
    {
      initialEntries: [`/rooms/${ROOM}`],
    },
  );
  render(
    <LocaleProvider initial="uz">
      <ApiProvider api={api}>
        <SessionContextForTest me={who}>
          <RouterProvider router={router} />
        </SessionContextForTest>
      </ApiProvider>
    </LocaleProvider>,
  );
}

describe('room page', () => {
  test('starting a lesson shows the grid', async () => {
    const { api, sent } = fakeApi({ activeLesson: null });
    renderRoom(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Darsni boshlash' }));
    expect(await screen.findByText('pc-01')).toBeTruthy();
    expect(screen.getByText('pc-02')).toBeTruthy();
    const start = sent.find((s) => s.path === `/api/v1/rooms/${ROOM}/lessons`);
    expect(start?.key).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  test('sending a message to selected devices posts their ids', async () => {
    const { api, sent } = fakeApi({ activeLesson: lesson });
    renderRoom(api);
    await screen.findByText('pc-02');
    fireEvent.click(screen.getByLabelText('pc-02 tanlash'));
    fireEvent.change(screen.getByLabelText('Xabar matni'), { target: { value: 'Salom' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xabar yuborish' }));
    await waitFor(() => expect(sent.some((s) => s.path.endsWith('/commands'))).toBe(true));
    const cmd = sent.find((s) => s.path === `/api/v1/lessons/${lesson.id}/commands`);
    expect(cmd?.body).toEqual({ type: 'message.show', payload: { text: 'Salom' }, targetDeviceIds: [id(11)] });
  });

  test('without a selection the command goes to the whole lesson', async () => {
    const { api, sent } = fakeApi({ activeLesson: lesson });
    renderRoom(api);
    await screen.findByText('pc-01');
    fireEvent.click(screen.getByRole('button', { name: 'Bloklash' }));
    await waitFor(() => expect(sent.some((s) => s.path.endsWith('/commands'))).toBe(true));
    expect(sent.find((s) => s.path.endsWith('/commands'))?.body).toEqual({ type: 'overlay.lock', payload: {} });
  });
  test('a school admin of another site sees the room but gets no commands or stream', async () => {
    const { api } = fakeApi({ activeLesson: lesson });
    const created: string[] = [];
    const router = createMemoryRouter(
      [
        {
          path: '/rooms/:roomId',
          element: (
            <RoomPage
              createFeed={(lessonId) => {
                created.push(lessonId);
                return { close() {} };
              }}
            />
          ),
        },
      ],
      { initialEntries: [`/rooms/${ROOM}`] },
    );
    const otherSiteAdmin = {
      ...me,
      user: { ...me.user, id: id(77) },
      assignments: [{ role: 'school_admin' as const, siteId: id(8) }],
    };
    render(
      <LocaleProvider initial="uz">
        <ApiProvider api={api}>
          <SessionContextForTest me={otherSiteAdmin}>
            <RouterProvider router={router} />
          </SessionContextForTest>
        </ApiProvider>
      </LocaleProvider>,
    );
    await screen.findByText('pc-01');
    expect(screen.queryByRole('button', { name: 'Xabar yuborish' })).toBeNull();
    expect(created).toEqual([]);
  });
});
