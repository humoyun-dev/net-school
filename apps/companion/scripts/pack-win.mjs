// P0c: Windows uchun installer'siz Companion (P2e'gacha). Electron win32 zip'i + resources/app (oddiy build) +
// netschool-helper.exe (P2d1 OS helper) + enroll.cmd/install.cmd/uninstall.cmd/start.cmd. Hech narsa Mac'da ishga
// tushirilmaydi — faqat zip yig'iladi.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip } from './zip.mjs';

export const ELECTRON_VERSION = '45.2.1';
const EXE = 'NetSchool Companion.exe';
const crlf = (lines) => `${lines.join('\r\n')}\r\n`;
const HELPER = 'netschool-helper.exe';
// `%~dp0` teskari chiziq bilan tugaydi: `"C:\pkg\"` Windows argv qoidasida yopuvchi qo'shtirnoqni ekranlaydi.
const INSTALL_LINE = `"%~dp0${HELPER}" install --companion-dir "%~dp0."`;

// Ro'yxatdan o'tkazadi (enroll helper kalitini `netschool-helper helper-key` bilan helper katalogida yaratadi va
// claim'dan keyin `set-hub` bilan hub sozlamalarini beradi), keyin helper'ni SYSTEM xizmati sifatida o'rnatadi:
// u Companion'ni har kirishda ishga tushiradi va kuzatadi. install eski HKLM Run autostart'ini (P0c) o'chiradi.
// .cmd fayllar Program Files'ga nusxalanmaydi: ular faqat shu paket katalogidan ishga tushiriladi.
const ENROLL_CMD = crlf([
  '@echo off',
  "rem Ro'yxatdan o'tkazish va helper'ni o'rnatish (administrator sifatida): enroll.cmd --hub https://<hub> --ca <hub-ca.pem>",
  "rem Oldin ro'yxatdan o'tgan kompyuter (helper kalitisiz): yangi token bilan --force qo'shing.",
  'setlocal',
  'set ELECTRON_RUN_AS_NODE=1',
  `"%~dp0${EXE}" "%~dp0resources\\app\\dist\\enroll.mjs" %*`,
  'if errorlevel 1 exit /b %errorlevel%',
  'set ELECTRON_RUN_AS_NODE=',
  INSTALL_LINE,
  'if errorlevel 1 exit /b %errorlevel%',
  "echo NetSchool Helper o'rnatildi: Companion'ni endi xizmat ishga tushiradi",
]);
// Yangi paketni qayta ro'yxatdan o'tkazmasdan o'rnatish (helper kaliti allaqachon helper katalogida).
const INSTALL_CMD = crlf(['@echo off', "rem Helper va Companion'ni yangilash (administrator sifatida).", INSTALL_LINE]);
const UNINSTALL_CMD = crlf([
  '@echo off',
  "rem Helper xizmatini, Companion'ni va siyosatlarni olib tashlash (administrator sifatida).",
  "rem Shu paket katalogidan ishga tushiring: o'rnatilgan nusxa (Program Files) o'zini o'chira olmaydi.",
  `"%~dp0${HELPER}" uninstall`,
]);
const START_CMD = crlf(['@echo off', `start "" "%~dp0${EXE}"`]);

function filesUnder(root) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

// node_modules'dan paketga faqat ishga tushishga kerakli fayllar (JS, JSON, native .node) kiradi.
const RUNTIME_FILE = /\.(c?js|mjs|json|node)$/;
export const KOFFI_VERSION = '3.3.6';
const koffiNative = (arch) => `@koromix/koffi-win32-${arch}`;

// Electron arch nomi → Go arch nomi (`pnpm build:helper`: native/helper/dist/netschool-helper-windows-<goarch>.exe).
const GO_ARCH = { x64: 'amd64', arm64: 'arm64' };

// Helper'siz paket bloklashni majburlay olmaydi va Companion autostart'siz qoladi: bunday paket yig'ilmaydi.
function readHelper(helperDistDir, arch) {
  const file = join(helperDistDir, `netschool-helper-windows-${GO_ARCH[arch]}.exe`);
  let data;
  try {
    data = readFileSync(file);
  } catch {
    throw new Error(`refusing to pack without the helper: ${file} is missing (run pnpm build:helper)`);
  }
  if (data.subarray(0, 2).toString('latin1') !== 'MZ')
    throw new Error(`the helper ${file} is not a Windows executable`);
  return data;
}

export async function packWin({
  arch,
  appDistDir,
  helperDistDir,
  outDir,
  getElectronZip,
  nodeModules,
  version = ELECTRON_VERSION,
}) {
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('arch must be x64 or arm64');
  const helper = readHelper(helperDistDir, arch);
  const main = readFileSync(join(appDistDir, 'main.cjs'), 'utf8');
  // Yashirin sinov rejimi faqat e2e test build'ida: o'quvchi kompyuteriga hech qachon tushmasin.
  if (main.includes('NETSCHOOL_COMPANION_TEST_HIDDEN')) throw new Error('refusing to pack a test build');
  const electron = readZip(await getElectronZip({ version, arch }));
  const entries = [];
  for (const e of electron) {
    if (e.name === 'resources/default_app.asar') continue;
    entries.push({ name: e.name === 'electron.exe' ? EXE : e.name, data: e.data });
  }
  entries.push({
    name: 'resources/app/package.json',
    data: Buffer.from(
      JSON.stringify({ name: 'netschool-companion', version: '0.0.0', main: 'dist/main.cjs' }, null, 2),
    ),
  });
  for (const file of filesUnder(appDistDir)) {
    if (file.endsWith('.map')) continue;
    entries.push({
      name: `resources/app/dist/${relative(appDistDir, file).split('\\').join('/')}`,
      data: readFileSync(file),
    });
  }
  // Kuchli bloklash hook'i (koffi) bundle'dan tashqarida: dist/main.cjs uni resources/app/node_modules'dan oladi.
  for (const { name, dir } of nodeModules) {
    for (const file of filesUnder(dir)) {
      const rel = relative(dir, file).split('\\').join('/');
      if (RUNTIME_FILE.test(rel))
        entries.push({ name: `resources/app/node_modules/${name}/${rel}`, data: readFileSync(file) });
    }
  }
  const native = `resources/app/node_modules/${koffiNative(arch)}/win32_${arch}/koffi.node`;
  if (
    !entries.some((e) => e.name === 'resources/app/node_modules/koffi/index.cjs') ||
    !entries.some((e) => e.name === native)
  ) {
    throw new Error(`refusing to pack without the keyboard hook: koffi and ${koffiNative(arch)} are required`);
  }
  entries.push(
    { name: HELPER, data: helper },
    { name: 'enroll.cmd', data: Buffer.from(ENROLL_CMD) },
    { name: 'install.cmd', data: Buffer.from(INSTALL_CMD) },
    { name: 'uninstall.cmd', data: Buffer.from(UNINSTALL_CMD) },
    { name: 'start.cmd', data: Buffer.from(START_CMD) },
  );
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `netschool-companion-win32-${arch}.zip`);
  writeFileSync(out, writeZip(entries));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const archArg = process.argv[process.argv.indexOf('--arch') + 1];
  const arch = process.argv.includes('--arch') ? archArg : 'x64';
  // Oddiy (production) build alohida katalogga: test build bayrog'i o'chiq.
  const build = mkdtempSync(join(tmpdir(), 'companion-win-'));
  try {
    const env = { ...process.env, NETSCHOOL_COMPANION_OUT: build };
    delete env.NETSCHOOL_COMPANION_TEST_BUILD;
    execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { env, stdio: 'inherit' });
    const { downloadArtifact } = await import('@electron/get');
    // pnpm-workspace.yaml `supportedArchitectures` win32 native paketini Mac/Linux'da ham (lockfile integrity bilan) o'rnatadi.
    const appRequire = createRequire(join(root, 'package.json'));
    const koffiDir = dirname(appRequire.resolve('koffi'));
    const koffiVersion = JSON.parse(readFileSync(join(koffiDir, 'package.json'), 'utf8')).version;
    if (koffiVersion !== KOFFI_VERSION) throw new Error(`koffi ${koffiVersion} != ${KOFFI_VERSION}`);
    const nativeDir = dirname(createRequire(join(koffiDir, 'index.cjs')).resolve(koffiNative(arch)));
    const out = await packWin({
      arch,
      appDistDir: build,
      helperDistDir: join(root, '..', '..', 'native', 'helper', 'dist'),
      nodeModules: [
        { name: 'koffi', dir: koffiDir },
        { name: koffiNative(arch), dir: nativeDir },
      ],
      outDir: join(root, 'out'),
      // @electron/get SHASUMS256.txt bo'yicha tekshiradi.
      getElectronZip: async ({ version, arch: a }) =>
        readFileSync(await downloadArtifact({ version, platform: 'win32', arch: a, artifactName: 'electron' })),
    });
    console.log(out);
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}
