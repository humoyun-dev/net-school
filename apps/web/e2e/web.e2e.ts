import type { BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ThumbnailStore } from '../../api/src/modules/thumbnails/thumbnail-store.ts';
import { PASSWORD } from '../../api/test/support/seed.ts';
import { startWorld, type World } from './harness.ts';

let world: World;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  world = await startWorld();
});
afterAll(async () => {
  await world?.close();
});
beforeEach(async () => {
  await context?.close().catch(() => {});
  context = await world.browser.newContext({ locale: 'uz-UZ' });
  page = await context.newPage();
  await world.heartbeat();
});

async function signIn(username: string, next = '/') {
  await page.goto(`${world.app.origin}/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Login').fill(username);
  await page.getByLabel('Parol').fill(PASSWORD);
  await page.getByRole('button', { name: 'Kirish' }).click();
}

async function openRoom() {
  await signIn('teacher1');
  await page.getByRole('link', { name: '101' }).click();
}

async function waitUntil(check: () => Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const tile = (hostname: string) => page.locator('article.tile', { hasText: hostname });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('web panel in a headless browser', () => {
  test('a teacher signs in, starts a lesson and sees live thumbnails', async () => {
    await openRoom();
    await page.getByRole('button', { name: 'Darsni boshlash' }).click();
    await expect.poll(() => tile('pc-01').count()).toBe(1);
    await expect.poll(() => tile('pc-02').count()).toBe(1);
    const lessonId = await world.activeLessonId();
    const store = world.app.get<ThumbnailStore>(ThumbnailStore);
    for (const d of world.devices) store.put(d.id, lessonId, JPEG);
    for (const d of world.devices) {
      await expect
        .poll(() => tile(d.hostname).locator('img').getAttribute('src'), { timeout: 10_000 })
        .toMatch(/^blob:/);
    }
  });

  test('a message reaches both devices and the per-device result shows succeeded', async () => {
    await openRoom();
    await page.getByLabel('Xabar matni').fill('Salom, sinf!');
    await page.getByRole('button', { name: 'Xabar yuborish' }).click();
    await waitUntil(async () => (await world.ackAll()) > 0);
    for (const d of world.devices) {
      await expect
        .poll(() => tile(d.hostname).locator('.result').textContent(), { timeout: 10_000 })
        .toBe('Xabar: Bajarildi');
    }
  });

  test('locking then unlocking shows the overlay state per device', async () => {
    await openRoom();
    await page.getByRole('button', { name: 'Bloklash' }).click();
    await waitUntil(async () => (await world.ackAll()) > 0);
    for (const d of world.devices) {
      await expect
        .poll(() => tile(d.hostname).locator('.result').textContent(), { timeout: 10_000 })
        .toBe('Bloklash: Bajarildi');
    }
    await page.getByRole('button', { name: 'Ochish', exact: true }).click();
    await waitUntil(async () => (await world.ackAll()) > 0);
    for (const d of world.devices) {
      await expect
        .poll(() => tile(d.hostname).locator('.result').textContent(), { timeout: 10_000 })
        .toBe('Ochish: Bajarildi');
    }
  });

  test('an org admin shuts down a room after confirming the device count and sees each result', async () => {
    await signIn('admin1', '/power');
    await page.getByLabel('Xonalar', { exact: true }).check();
    await page.getByLabel('101').check();
    await page.getByRole('button', { name: 'Davom etish' }).click();
    const dialog = page.getByRole('dialog');
    await expect.poll(() => dialog.getByText('2 ta kompyuter').count()).toBe(1);
    await dialog.getByLabel('Qurilmalar sonini yozing').fill('2');
    await dialog.getByRole('button', { name: 'Tasdiqlash' }).click();
    // PowerWorker (haqiqiy 1 s tick) yuboradi; kompyuterlar "o'chadi".
    await waitUntil(async () => world.mesh.powerRequests.length === 2);
    for (const d of world.devices) {
      const node = world.mesh.nodes.get(d.nodeId);
      if (node) node.online = false;
    }
    const rows = page.locator('table.targets tr');
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(2);
    await expect
      .poll(async () => (await rows.allTextContents()).every((t) => t.includes('Bajarildi')), { timeout: 15_000 })
      .toBe(true);
    for (const d of world.devices) {
      const node = world.mesh.nodes.get(d.nodeId);
      if (node) node.online = true;
    }
  });

  test('a teacher has no power page', async () => {
    await signIn('teacher1', '/power');
    await expect.poll(() => page.getByText("Bu sahifaga ruxsatingiz yo'q").count()).toBe(1);
    await expect.poll(() => page.getByRole('link', { name: 'Quvvat' }).count()).toBe(0);
  });
});
