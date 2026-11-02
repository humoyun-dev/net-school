import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { startTestApp, type TestApp } from '../../api/test/support/app.ts';
import { startLesson } from '../../api/test/support/lesson.ts';
import { loginAs } from '../../api/test/support/login.ts';
import { seedOrg, seedRoom, seedUser } from '../../api/test/support/seed.ts';
import { runEnrollCli } from '../src/cli/enroll.ts';
import { strings } from '../src/core/i18n.ts';

const companionDir = join(import.meta.dirname, '..');
const electronPath: string = createRequire(join(companionDir, 'package.json'))('electron');
export const MAIN = join(companionDir, 'dist', 'main.cjs');
// Sinovlar o'zbekcha matnlar bilan: til NETSCHOOL_COMPANION_LOCALE bilan qotiriladi.
export const T = strings.uz;

export interface World {
  app: TestApp;
  admin: string;
  siteId: string;
  roomId: string;
  lessonId: string;
  deviceId: string;
  machineDir: string;
  stateDir: string;
}

// Real hub, tizimga kiritilgan admin, ro'yxatdan o'tgan qurilma (haqiqiy `enroll` CLI) va faol dars.
export async function createWorld(): Promise<World> {
  // Fon workerlari yoqilgan: outbox qurilmaning long-poll'ini darhol uyg'otadi (haqiqiy hub kabi).
  const app = await startTestApp({ workers: true });
  const { orgId, siteId } = await seedOrg(app.db.db);
  const roomId = await seedRoom(app.db.db, orgId, siteId, '101');
  await seedUser(app.db.db, orgId, 'admin1', [{ role: 'school_admin', siteId }]);
  const admin = await loginAs(app, 'admin1');

  const root = mkdtempSync(join(tmpdir(), 'ns-e2e-'));
  const machineDir = join(root, 'machine');
  const stateDir = join(root, 'state');
  const caFile = join(root, 'hub-ca.pem');
  writeFileSync(caFile, app.ca);
  const token = (await app.request('POST', '/api/v1/enrollments', { body: { siteId, roomId }, cookie: admin })).json
    .token as string;
  const lines: string[] = [];
  const code = await runEnrollCli(
    ['--hub', app.origin, '--ca', caFile],
    { NETSCHOOL_COMPANION_DIR: machineDir, NETSCHOOL_ENROLL_TOKEN: token },
    { out: (l) => lines.push(l), err: (l) => lines.push(l) },
  );
  if (code !== 0) throw new Error(`enroll failed (${code}): ${lines.join(' ')}`);
  const { deviceId } = JSON.parse(readFileSync(join(machineDir, 'device.json'), 'utf8')) as { deviceId: string };
  const lessonId = (await startLesson(app, admin, roomId)).json.id as string;
  return { app, admin, siteId, roomId, lessonId, deviceId, machineDir, stateDir };
}

export function launch(world: World): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: electronPath,
    args: [MAIN],
    env: {
      ...process.env,
      NETSCHOOL_COMPANION_DIR: world.machineDir,
      NETSCHOOL_COMPANION_STATE_DIR: world.stateDir,
      NETSCHOOL_COMPANION_SHOW_STATUS: '1',
      NETSCHOOL_COMPANION_LOCALE: 'uz',
      // Oynalar ekranda ko'rsatilmaydi: sinov ishchi ekranni qoplamaydi.
      NETSCHOOL_COMPANION_TEST_HIDDEN: '1',
    },
  });
}

export async function eventually<T>(
  check: () => T | null | false | undefined | Promise<T | null | false | undefined>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const windowsOf = (electron: ElectronApplication, page: string): Page[] =>
  electron.windows().filter((w) => w.url().endsWith(`/${page}`) && !w.isClosed());

export const windowOf = (electron: ElectronApplication, page: string): Promise<Page> =>
  eventually(() => windowsOf(electron, page)[0]);
