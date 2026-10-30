import type { IncomingMessage } from 'node:http';
import { tick } from '@netschool/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type WebSocket from 'ws';
import { remoteSessions } from '../../apps/api/src/db/schema.ts';
import { type ApiInstance, newKey, type SeededLesson, startApi } from './harness/api.ts';
import type { Browser } from './harness/gateway.ts';
import { type MeshCentralInstance, startMeshCentral } from './harness/meshcentral.ts';

// Revoke chegarasi (global constraints): yopilish commit'idan keyin soketlar va principal ≤ 2 s.
const REVOKE_BUDGET_MS = 2_000;
// Reconciler qayta urinishlari (har 5 s): bitta urinish o'tkazib yuborilsa ham ro'yxatlash/o'chirish sig'adi.
const RETRY_BUDGET_MS = 20_000;

let mc: MeshCentralInstance;
let api: ApiInstance;

beforeAll(async () => {
  mc = await startMeshCentral();
  api = await startApi(mc);
});

afterAll(async () => {
  await api?.close();
  await mc?.stop();
});

const openSession = (cookie: string, lessonId: string, body: { deviceId: string; mode: 'view' | 'control' }) =>
  api.request('POST', `/api/v1/lessons/${lessonId}/remote-sessions`, { cookie, body, key: newKey() });

interface Viewer {
  browser: Browser;
  control: WebSocket;
  frames: string[];
}

// Brauzer yo'li: ticket → redeem (303) → kirish sahifasi → gateway orqali control.ashx, MeshCentral serverinfo'si bilan.
async function attachViewer(cookie: string, sessionId: string): Promise<Viewer> {
  const issued = await api.request('POST', `/api/v1/remote-sessions/${sessionId}/ticket`, { cookie });
  expect(issued.status).toBe(200);
  const url = new URL(issued.json.url);
  expect(url.origin).toBe(api.gatewayOrigin);
  expect(url.pathname).toBe('/rs/redeem');
  const browser = api.browser();
  const redeemed = await browser.redeem(url.searchParams.get('ticket') ?? '');
  expect(redeemed.status).toBe(303);
  const entry = await browser.get(String(redeemed.headers.location));
  expect(entry.status).toBe(200);

  const control = browser.socket('/control.ashx');
  const frames: string[] = [];
  control.on('message', (data) => frames.push(data.toString()));
  control.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    control.once('open', () => resolve());
    control.once('error', reject);
    control.once('unexpected-response', (_req, res: IncomingMessage) => reject(new Error(`upgrade ${res.statusCode}`)));
  });
  await waitFor(() => frames.some((f) => f.includes('"serverinfo"')), 8_000, 'serverinfo through the gateway');
  return { browser, control, frames };
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await tick(25);
  }
}

// Soket yopilgan payt; `deadline`gacha yopilmasa undefined. Tinglovchi yopishdan OLDIN o'rnatiladi.
function closeBy(ws: WebSocket, deadline: () => number): Promise<{ code: number; at: number } | undefined> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const watch = () => {
      timer = setTimeout(() => (Date.now() > deadline() ? resolve(undefined) : watch()), 25);
    };
    watch();
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, at: Date.now() });
    });
  });
}

// Principal yo'qligi kuzatilgan payt — ro'yxat javobi kelgan vaqt (konservativ); `deadline`dan keyin xato.
async function principalGoneAt(id: string, deadline: number): Promise<number> {
  for (;;) {
    const ids = await api.principalSessionIds();
    const at = Date.now();
    if (!ids.includes(id)) return at;
    if (at > deadline) throw new Error(`principal ns-sess-${id} still present after the deadline`);
    await tick(25);
  }
}

const sessionRows = () => api.db.db.select().from(remoteSessions);
const sessionRow = async (id: string) => (await sessionRows()).find((r) => r.id === id);

async function openControl(lesson: SeededLesson, cookie: string): Promise<string> {
  const opened = await openSession(cookie, lesson.lessonId, { deviceId: lesson.deviceId, mode: 'control' });
  expect(opened.status).toBe(201);
  expect(opened.json).toMatchObject({ status: 'active', mode: 'control', lease: { fencing: expect.any(String) } });
  return opened.json.id;
}

describe('remote sessions through the API against pinned MeshCentral', () => {
  test('control session opens through the API and the gateway', async () => {
    const lesson = await api.seedLessonWithBoundDevice();
    const teacher = await api.login('teacher1');
    const id = await openControl(lesson, teacher);
    // MeshCentral'da shu sessiyaning principal'i: ns-sess-<id>.
    expect(await api.principalSessionIds()).toContain(id);

    const viewer = await attachViewer(teacher, id);
    expect(viewer.control.readyState).toBe(viewer.control.OPEN);

    let deadline = Number.POSITIVE_INFINITY;
    const closed = closeBy(viewer.control, () => deadline);
    const deleted = await api.request('DELETE', `/api/v1/remote-sessions/${id}`, { cookie: teacher });
    expect(deleted.status).toBe(204);
    deadline = Date.now() + REVOKE_BUDGET_MS;
    expect(await closed).toMatchObject({ code: 1008 });
    await principalGoneAt(id, deadline);
    expect(await sessionRow(id)).toMatchObject({ status: 'closed', closeReason: 'teacher' });
  });

  test('ending the lesson closes viewer sockets within two seconds and deletes the principal', async () => {
    const lesson = await api.seedLessonWithBoundDevice();
    const teacher = await api.login('teacher1');
    const id = await openControl(lesson, teacher);
    const viewer = await attachViewer(teacher, id);
    // 2 s chegarasi `POST …/end` javobidan boshlanadi; yopilish undan oldin bo'lishi ham mumkin.
    let deadline = Number.POSITIVE_INFINITY;
    const closed = closeBy(viewer.control, () => deadline);

    const ended = await api.request('POST', `/api/v1/lessons/${lesson.lessonId}/end`, {
      cookie: teacher,
      body: {},
      key: newKey(),
    });
    deadline = Date.now() + REVOKE_BUDGET_MS;
    expect(ended.status).toBe(200);

    const [socket, goneAt] = await Promise.all([closed, principalGoneAt(id, deadline)]);
    expect(socket?.code).toBe(1008);
    expect(socket?.at).toBeLessThanOrEqual(deadline);
    expect(goneAt).toBeLessThanOrEqual(deadline);
    expect(await sessionRow(id)).toMatchObject({ status: 'closed', closeReason: 'lesson_ended' });
  });

  test('second teacher gets control_busy against real MeshCentral', async () => {
    const lesson = await api.seedLessonWithBoundDevice();
    const teacher = await api.login('teacher1');
    const id = await openControl(lesson, teacher);
    const before = await api.principalSessionIds();
    expect(before).toContain(id);

    // Ikkinchi controller: o'sha o'qituvchining boshqa oynasi va maktab admini (boshqa o'qituvchi begona
    // darsda ochishga umuman ruxsat olmaydi — 403, lease'gacha yetmaydi).
    const admin = await api.login('admin1');
    for (const cookie of [teacher, admin]) {
      const busy = await openSession(cookie, lesson.lessonId, { deviceId: lesson.deviceId, mode: 'control' });
      expect(busy.status).toBe(409);
      expect(busy.json.error.code).toBe('control_busy');
    }
    // Hech narsa yozilmagan va MeshCentral'da yangi principal yo'q.
    const rows = (await sessionRows()).filter((r) => r.lessonId === lesson.lessonId);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect((await api.principalSessionIds()).sort()).toEqual(before.sort());

    expect((await api.request('DELETE', `/api/v1/remote-sessions/${id}`, { cookie: teacher })).status).toBe(204);
  });

  // Oxirgi test: restart hamma sessiyani yopadi, shuning uchun hamma `ns-sess-*` principal o'chiriladi.
  test('restart reconciliation deletes leftover principals', async () => {
    const lesson = await api.seedLessonWithBoundDevice();
    const teacher = await api.login('teacher1');
    const id = await openControl(lesson, teacher);

    // Yiqilish: revoke yo'q — principal MeshCentral'da va sessiya DB'da ochiq qoladi.
    await api.restart(async () => {
      expect(await api.principalSessionIds()).toContain(id);
      expect(await sessionRow(id)).toMatchObject({ status: 'active', closedAt: null });
    });

    // DB qismi startup ichida: yangi app tinglashni boshlaganda sessiya allaqachon `restart` bilan yopilgan.
    expect(await sessionRow(id)).toMatchObject({ status: 'closed', closeReason: 'restart', closedBy: null });
    // Startup'da MeshCentral ulanishi hali tayyor emas (main.ts kutmaydi): principal birinchi qayta urinishda (5 s)
    // o'chiriladi.
    await waitFor(async () => !(await api.principalSessionIds()).includes(id), RETRY_BUDGET_MS, 'principal deleted');
  });
});
