import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { packWin } from '../scripts/pack-win.mjs';
import { readZip, writeZip } from '../scripts/zip.mjs';

let dir: string;
let appDist: string;
const requested: { version: string; arch: string }[] = [];

function fakeElectronZip(arch: string): Buffer {
  return writeZip([
    { name: 'electron.exe', data: Buffer.from(`MZ electron ${arch}`) },
    { name: 'ffmpeg.dll', data: Buffer.from('dll') },
    { name: 'resources/default_app.asar', data: Buffer.from('default app') },
    { name: 'version', data: Buffer.from('45.2.1') },
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pack-'));
  appDist = join(dir, 'dist');
  mkdirSync(join(appDist, 'renderer'), { recursive: true });
  writeFileSync(join(appDist, 'main.cjs'), 'require("electron")');
  writeFileSync(join(appDist, 'enroll.mjs'), 'export {}');
  writeFileSync(join(appDist, 'renderer', 'status.html'), '<html></html>');
  requested.length = 0;
});

// koffi (kuchli bloklash hook'i) va uning win32 native paketi: faqat ishga tushishga kerakli fayllar.
function fakeNodeModules(arch: string) {
  const koffi = join(dir, 'nm', 'koffi');
  const native = join(dir, 'nm', `koffi-win32-${arch}`);
  const files: Record<string, string> = {
    [join(koffi, 'package.json')]: '{"name":"koffi","main":"./index.cjs"}',
    [join(koffi, 'index.cjs')]: 'module.exports = require("./src/koffi/index.cjs")',
    [join(koffi, 'src/koffi/src/static.cjs')]: 'static',
    [join(koffi, 'README.md')]: 'docs',
    [join(koffi, 'vendor/node-api-headers/include/node_api.h')]: 'header',
    [join(koffi, 'lib/native/base/base.cc')]: 'source',
    [join(native, 'package.json')]: `{"name":"@koromix/koffi-win32-${arch}"}`,
    [join(native, 'index.js')]: `module.exports = require('./win32_${arch}/koffi.node')`,
    [join(native, `win32_${arch}/koffi.node`)]: 'MZ native',
    [join(native, `win32_${arch}/koffi.lib`)]: 'import lib',
  };
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, data);
  }
  return [
    { name: 'koffi', dir: koffi },
    { name: `@koromix/koffi-win32-${arch}`, dir: native },
  ];
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pack = (arch: 'x64' | 'arm64', nodeModules = fakeNodeModules(arch)) =>
  packWin({
    arch,
    appDistDir: appDist,
    nodeModules,
    outDir: join(dir, 'out'),
    getElectronZip: async (opts: { version: string; arch: string }) => {
      requested.push(opts);
      return fakeElectronZip(opts.arch);
    },
  });

describe('Windows portable package', () => {
  test('zip entries survive a write and read round trip', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello'.repeat(100)) },
      { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 255]) },
    ];
    expect(readZip(writeZip(entries)).map((e) => [e.name, e.data.toString('hex')])).toEqual(
      entries.map((e) => [e.name, e.data.toString('hex')]),
    );
  });

  test('the zip name and Electron binary match the requested arch', async () => {
    const out = await pack('arm64');
    expect(out).toMatch(/netschool-companion-win32-arm64\.zip$/);
    expect(requested).toEqual([{ version: '45.2.1', arch: 'arm64' }]);
    const names = new Map(readZip(readFileSync(out)).map((e) => [e.name, e.data]));
    expect(names.get('NetSchool Companion.exe')?.toString()).toBe('MZ electron arm64');
    expect(names.has('electron.exe')).toBe(false);
    expect(names.has('resources/default_app.asar')).toBe(false);
    expect(names.has('ffmpeg.dll')).toBe(true);
  });

  test('the app bundle is a production build without the hidden test mode', async () => {
    const out = await pack('x64');
    const names = new Map(readZip(readFileSync(out)).map((e) => [e.name, e.data]));
    expect(JSON.parse(names.get('resources/app/package.json')?.toString() ?? '{}')).toMatchObject({
      main: 'dist/main.cjs',
    });
    expect(names.has('resources/app/dist/main.cjs')).toBe(true);
    expect(names.has('resources/app/dist/renderer/status.html')).toBe(true);
    writeFileSync(join(appDist, 'main.cjs'), 'const x = "NETSCHOOL_COMPANION_TEST_HIDDEN";');
    await expect(pack('x64')).rejects.toThrow(/test build/);
  });

  test('enroll.cmd runs enroll.mjs through Electron as Node', async () => {
    const out = await pack('x64');
    const names = new Map(readZip(readFileSync(out)).map((e) => [e.name, e.data.toString()]));
    const enroll = names.get('enroll.cmd') ?? '';
    expect(enroll).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(enroll).toContain('"%~dp0NetSchool Companion.exe" "%~dp0resources\\app\\dist\\enroll.mjs" %*');
    expect(enroll).toContain('\r\n');
    expect(names.get('start.cmd')).toContain('"%~dp0NetSchool Companion.exe"');
  });

  // Companion har foydalanuvchi kirishida o'zi ishga tushadi: HKLM Run (oddiy o'quvchi o'chira olmaydi).
  test('a successful enroll registers Companion to start at every sign-in', async () => {
    const out = await pack('x64');
    const names = new Map(readZip(readFileSync(out)).map((e) => [e.name, e.data.toString()]));
    const lines = (names.get('enroll.cmd') ?? '').split('\r\n');
    const run = lines.findIndex((l) => l.includes('enroll.mjs'));
    const stop = lines.indexOf('if errorlevel 1 exit /b %errorlevel%');
    const reg = lines.findIndex((l) => l.startsWith('reg add '));
    // Ro'yxatdan o'tish yiqilsa autostart yozilmaydi.
    expect(run).toBeGreaterThanOrEqual(0);
    expect(stop).toBe(run + 1);
    expect(reg).toBeGreaterThan(stop);
    expect(lines[reg]).toBe(
      'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" /v "NetSchool Companion" /t REG_SZ /d "\\"%~dp0NetSchool Companion.exe\\"" /f >nul',
    );
    const off = names.get('remove-autostart.cmd') ?? '';
    expect(off).toContain(
      'reg delete "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" /v "NetSchool Companion" /f',
    );
  });

  // Hook koffi'siz yuklanmaydi va overlay jimgina yumshoq qoladi: bunday paket umuman yig'ilmaydi.
  test('the keyboard hook native module ships next to the app, runtime files only', async () => {
    const out = await pack('arm64');
    const names = new Map(readZip(readFileSync(out)).map((e) => [e.name, e.data.toString()]));
    const nm = 'resources/app/node_modules';
    expect(names.get(`${nm}/koffi/index.cjs`)).toContain('require("./src/koffi/index.cjs")');
    expect(names.has(`${nm}/koffi/package.json`)).toBe(true);
    expect(names.has(`${nm}/koffi/src/koffi/src/static.cjs`)).toBe(true);
    expect(names.get(`${nm}/@koromix/koffi-win32-arm64/win32_arm64/koffi.node`)).toBe('MZ native');
    expect(names.has(`${nm}/@koromix/koffi-win32-arm64/index.js`)).toBe(true);
    for (const name of names.keys()) expect(name).not.toMatch(/\.(md|h|cc|lib)$/);
  });

  test('a package without the native module for the requested arch is refused', async () => {
    await expect(pack('x64', [])).rejects.toThrow(/koffi/);
    await expect(pack('x64', fakeNodeModules('arm64'))).rejects.toThrow(/koffi-win32-x64/);
  });
});
