// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiProvider } from '../src/api/api-context.tsx';
import type { Api } from '../src/api/client.ts';
import { DeviceTile } from '../src/classroom/device-tile.tsx';
import { WebPolicyControl } from '../src/classroom/web-policy-control.tsx';
import { LocaleProvider } from '../src/i18n/i18n.tsx';

afterEach(cleanup);
const LESSON = '00000000-0000-4000-8000-000000000001';

test('teacher sets allowlist for the lesson', async () => {
  const sent: { method: string; path: string; body: unknown; headers?: Record<string, string> }[] = [];
  const api = {
    get: vi.fn(async () => ({ current: null })),
    send: vi.fn(
      async (method: string, path: string, body: unknown, _s: unknown, opts?: { headers?: Record<string, string> }) => {
        sent.push({ method, path, body, headers: opts?.headers });
        return {
          id: '00000000-0000-4000-8000-000000000002',
          layer: 'lesson',
          siteId: '00000000-0000-4000-8000-000000000003',
          lessonId: LESSON,
          version: 1,
          document: body,
          contentHash: 'h',
          createdBy: '00000000-0000-4000-8000-000000000004',
          createdAt: '2026-11-12T10:00:00.000Z',
          restoredFrom: null,
        };
      },
    ),
  } as unknown as Api;
  render(
    <LocaleProvider initial="uz">
      <ApiProvider api={api}>
        <WebPolicyControl lessonId={LESSON} />
      </ApiProvider>
    </LocaleProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Web' }));
  fireEvent.click(await screen.findByRole('radio', { name: 'Faqat shu saytlar' }));
  fireEvent.change(screen.getByLabelText('Saytlar'), { target: { value: 'docs.example.com\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Saqlash' }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({
    method: 'PUT',
    path: `/api/v1/lessons/${LESSON}/policy`,
    body: { schemaVersion: 1, web: { mode: 'allowlist', patterns: ['docs.example.com'] } },
    headers: { 'if-match': '0' },
  });
});

test('device tile shows partial policy reason', () => {
  render(
    <LocaleProvider initial="uz">
      <DeviceTile
        device={
          {
            id: '00000000-0000-4000-8000-000000000005',
            hostname: 'pc-01',
            companion: { presence: 'online' },
            agent: 'online',
          } as never
        }
        frameUrl={null}
        help={null}
        result={null}
        selected={false}
        canCommand={false}
        onToggle={() => {}}
        onClearHelp={() => {}}
        policy={{ status: 'partial', reasons: ['unmanaged_browser'] }}
      />
    </LocaleProvider>,
  );
  const badge = screen.getByText('Siyosat qisman');
  expect(badge.closest('[title]')?.getAttribute('title')).toBe('unmanaged_browser');
});
