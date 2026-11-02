import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { issueCommand } from '../../api/test/support/lesson.ts';
import { createWorld, eventually, launch, T, type World, windowOf, windowsOf } from './harness.ts';

let world: World;
let electron: ElectronApplication | null = null;
let hubClosed = false;

const capabilitiesReported = async () =>
  JSON.stringify(
    (await world.app.request('GET', `/api/v1/sites/${world.siteId}/devices`, { cookie: world.admin })).json,
  ).includes('classroom.overlay');
const online = async () =>
  (await (await windowOf(electron as ElectronApplication, 'status.html')).textContent('#root'))?.includes(T.hubOnline);

beforeAll(async () => {
  world = await createWorld();
  electron = await launch(world);
  await eventually(online);
  await eventually(capabilitiesReported);
});
afterAll(async () => {
  await electron?.close().catch(() => {});
  if (!hubClosed) await world?.app.close();
});

describe('companion in real Electron', () => {
  test('renderers are sandboxed and pages have no Node', async () => {
    const app = electron as ElectronApplication;
    const page = await windowOf(app, 'status.html');
    const inPage = await page.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys(window.netschool).sort(),
    }));
    expect(inPage.require).toBe('undefined');
    expect(inPage.process).toBe('undefined');
    // Rendererga faqat shu allowlist beriladi: kalit, DB yoki hub manzili yo'q.
    expect(inPage.bridge).toEqual(['dismissMessage', 'onMessage', 'onStatus', 'raiseHelp', 'strings', 'withdrawHelp']);

    const prefs = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => {
        const p = (
          w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
        ).getLastWebPreferences();
        return {
          sandbox: p.sandbox,
          contextIsolation: p.contextIsolation,
          nodeIntegration: p.nodeIntegration,
          webviewTag: p.webviewTag,
        };
      }),
    );
    expect(prefs.length).toBeGreaterThan(0);
    for (const p of prefs)
      expect(p).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });

    // Holat oynasi hub bilan aloqa va darsni ko'rsatadi.
    const text = await page.textContent('#root');
    expect(text).toContain(T.hubOnline);
    expect(text).toContain(T.lessonActive);
  });

  test('a teacher lock covers the screen and unlock removes it', async () => {
    const app = electron as ElectronApplication;
    const lock = await issueCommand(world.app, world.admin, world.lessonId, {
      type: 'overlay.lock',
      payload: { message: 'Diqqat qiling' },
    });
    expect(lock.status).toBe(202);

    const overlay = await windowOf(app, 'overlay.html');
    await eventually(async () => (await overlay.textContent('#root'))?.includes('Diqqat qiling'));
    const text = (await overlay.textContent('#root')) ?? '';
    expect(text).toContain(T.overlayTitle);
    expect(text).toContain(T.overlayNote); // "yumshoq" ekani ko'rsatiladi

    const shape = await app.evaluate(({ BrowserWindow, screen }) => {
      const overlays = BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('overlay.html'));
      return {
        displays: screen.getAllDisplays().length,
        overlays: overlays.length,
        topmost: overlays.every((w) => w.isAlwaysOnTop()),
        // Xatti-harakat tekshiriladi, bayroq emas: Linux'da `closable` qo'llanmaydi, yopishni `close` handler to'xtatadi.
        survivesClose: (() => {
          for (const w of overlays) w.close();
          return overlays.every((w) => !w.isDestroyed());
        })(),
        coversDisplay: overlays.every((w) =>
          screen.getAllDisplays().some((d) => {
            const b = w.getBounds();
            // Overlay displeyni to'liq qoplaydi (macOS'da menyu satri ostiga ham chiqishi mumkin).
            return (
              b.x <= d.bounds.x &&
              b.y <= d.bounds.y &&
              b.x + b.width >= d.bounds.x + d.bounds.width &&
              b.y + b.height >= d.bounds.y + d.bounds.height
            );
          }),
        ),
      };
    });
    expect(shape).toMatchObject({ overlays: shape.displays, topmost: true, survivesClose: true });
    // Linux'da yashirin (ekranga chiqarilmagan) oynaga oyna menejerisiz X11 koordinatalarni qo'llamaydi —
    // u yerda qoplash faqat ko'rinadigan rejimda tekshiriladi.
    if (process.platform !== 'linux') expect(shape.coversDisplay).toBe(true);

    await eventually(async () => {
      const c = (await world.app.request('GET', `/api/v1/commands/${lock.json.id}`, { cookie: world.admin })).json;
      return c.targets[0].status === 'succeeded';
    });

    await issueCommand(world.app, world.admin, world.lessonId, { type: 'overlay.unlock', payload: {} });
    await eventually(() => windowsOf(app, 'overlay.html').length === 0);
  });

  test('a teacher message is shown to the student as plain text', async () => {
    const app = electron as ElectronApplication;
    const hostile = '<img src=x onerror=alert(1)> <b>qalin</b> & Daftarlarni oching';
    expect(
      (await issueCommand(world.app, world.admin, world.lessonId, { type: 'message.show', payload: { text: hostile } }))
        .status,
    ).toBe(202);
    const message = await windowOf(app, 'message.html');
    await eventually(async () => (await message.textContent('.text')) === hostile);
    expect(await message.locator('.text img, .text b').count()).toBe(0); // HTML sifatida talqin qilinmaydi
    expect(await message.textContent('h1')).toBe(T.messageTitle);

    await message.getByRole('button', { name: T.messageOk }).click();
    await eventually(() => windowsOf(app, 'message.html').length === 0);
  });

  test('the help button raises help for the teacher', async () => {
    const app = electron as ElectronApplication;
    const page = await windowOf(app, 'status.html');
    await page.getByRole('button', { name: T.helpRaise }).click();
    await eventually(async () => (await page.textContent('#root'))?.includes(T.helpSent));

    const snapshot = (await world.app.request('GET', `/api/v1/events?roomId=${world.roomId}`, { cookie: world.admin }))
      .json;
    expect(snapshot.snapshot.helpRequests).toHaveLength(1);
    expect(snapshot.snapshot.helpRequests[0].deviceId).toBe(world.deviceId);
  });

  // Oxirgi test: ilovani va hub'ni to'xtatib qayta ishga tushiradi.
  test('relaunching while locked restores the overlay', async () => {
    await issueCommand(world.app, world.admin, world.lessonId, {
      type: 'overlay.lock',
      payload: { message: 'Qayta ishga tushirish' },
    });
    // Yangi lock qurilmaga yetib, keshga yozilganini kutamiz (oldingi testdan qolgan lock bo'lishi mumkin).
    const before = await windowOf(electron as ElectronApplication, 'overlay.html');
    await eventually(async () => (await before.textContent('#root'))?.includes('Qayta ishga tushirish'));

    await (electron as ElectronApplication).close();
    electron = null;
    hubClosed = true;
    await world.app.close(); // hub yo'q: heartbeat muvaffaqiyatsiz bo'ladi

    electron = await launch(world);
    // Hub bilan aloqasiz ham lock keshdan darhol tiklanadi (lease tugamagan, boot o'sha).
    const overlay = await windowOf(electron, 'overlay.html');
    await eventually(async () => (await overlay.textContent('#root'))?.includes('Qayta ishga tushirish'));
    const status = await windowOf(electron, 'status.html');
    await eventually(async () => (await status.textContent('#root'))?.includes(T.hubOffline));
  });
});

describe('a broken enrollment', () => {
  test('a corrupt enrollment shows the reason instead of vanishing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ns-e2e-broken-'));
    const machineDir = join(root, 'machine');
    mkdirSync(machineDir);
    writeFileSync(join(machineDir, 'device.json'), '{ not json');
    const app = await launch({ machineDir, stateDir: join(root, 'state') } as World);
    try {
      const status = await windowOf(app, 'status.html');
      await eventually(async () => (await status.textContent('#root'))?.includes(T.enrollmentBroken));
    } finally {
      await app.close();
    }
  });
});
