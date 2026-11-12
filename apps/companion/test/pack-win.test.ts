import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FUSE_SENTINEL, flipFuses, packWin } from '../scripts/pack-win.mjs';
import { readZip, writeZip } from '../scripts/zip.mjs';

let dir: string;
let appDist: string;
let helperDist: string;
const requested: { version: string; arch: string }[] = [];

// Haqiqiy electron.exe'dagi fuse simi (Electron 45.2.1 win32-x64: versiya 1, 9 fuse, "101100011").
const fuseWire = (fuses = '101100011') =>
  Buffer.concat([Buffer.from(FUSE_SENTINEL), Buffer.from([1, fuses.length]), Buffer.from(fuses, 'latin1')]);
const fakeExe = (arch: string) =>
  Buffer.concat([Buffer.from(`MZ electron ${arch} `), fuseWire(), Buffer.from(' tail')]);

function fakeElectronZip(arch: string): Buffer {
  return writeZip([
    { name: 'electron.exe', data: fakeExe(arch) },
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
  // `pnpm build:helper` natijasi (native/helper/dist): Go arch nomlari.
  helperDist = join(dir, 'helper-dist');
  mkdirSync(helperDist);
  for (const goArch of ['amd64', 'arm64'])
    writeFileSync(join(helperDist, `netschool-helper-windows-${goArch}.exe`), `MZ helper ${goArch}`);
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
    helperDistDir: helperDist,
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
    expect(names.get('NetSchool Companion.exe')?.toString('latin1')).toMatch(/^MZ electron arm64 /);
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

  // Companion'ni endi SYSTEM xizmati (NetSchool Helper) ishga tushiradi va kuzatadi: enroll muvaffaqiyatli bo'lsa
  // helper o'rnatiladi. HKLM Run autostart yozilmaydi (install eskisini o'chiradi), aks holda ikki Companion bo'lardi.
  test('enroll.cmd installs the helper after a successful enroll', async () => {
    const out = await pack('x64');
    const names = new Map(readZip(readFileSync(out)).map((e) => [e.name, e.data.toString()]));
    const lines = (names.get('enroll.cmd') ?? '').split('\r\n');
    const run = lines.findIndex((l) => l.includes('enroll.mjs'));
    const stop = lines.indexOf('if errorlevel 1 exit /b %errorlevel%');
    const install = lines.findIndex((l) => l.includes('netschool-helper.exe'));
    // Ro'yxatdan o'tish yiqilsa helper o'rnatilmaydi.
    expect(run).toBeGreaterThanOrEqual(0);
    expect(stop).toBe(run + 1);
    expect(install).toBeGreaterThan(stop);
    // `%~dp0` `\` bilan tugaydi: `"...\"` Windows argv'da qo'shtirnoqni ekranlaydi, shuning uchun `%~dp0.`.
    expect(lines[install]).toBe('"%~dp0netschool-helper.exe" install --companion-dir "%~dp0."');
    expect(lines[install + 1]).toBe('if errorlevel 1 exit /b %errorlevel%');
    for (const cmd of names.keys()) {
      if (cmd.endsWith('.cmd')) expect(names.get(cmd)).not.toMatch(/reg add/i);
    }
    expect(names.has('remove-autostart.cmd')).toBe(false);
    expect(names.get('uninstall.cmd')).toContain('"%~dp0netschool-helper.exe" uninstall');
    // uninstall o'rnatilgan nusxadan ishlamaydi (o'zini o'chira olmaydi): paket katalogidan.
    expect(names.get('uninstall.cmd')).toMatch(/paket katalogidan/);
    // Yangi versiyani qayta ro'yxatdan o'tkazmasdan o'rnatish (yangilash).
    expect(names.get('install.cmd')).toContain('"%~dp0netschool-helper.exe" install --companion-dir "%~dp0."');
  });

  test('the package carries the helper and refuses to build without it', async () => {
    for (const [arch, goArch] of [
      ['x64', 'amd64'],
      ['arm64', 'arm64'],
    ] as const) {
      const out = await pack(arch);
      const names = new Map(readZip(readFileSync(out)).map((e) => [e.name, e.data.toString()]));
      expect(names.get('netschool-helper.exe')).toBe(`MZ helper ${goArch}`);
    }
    rmSync(join(helperDist, 'netschool-helper-windows-amd64.exe'));
    await expect(pack('x64')).rejects.toThrow(/netschool-helper-windows-amd64\.exe/);
    // Boshqa arch'niki o'rniga qo'yilmaydi va PE bo'lmagan fayl qabul qilinmaydi.
    writeFileSync(join(helperDist, 'netschool-helper-windows-amd64.exe'), 'not a PE');
    await expect(pack('x64')).rejects.toThrow(/helper/);
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

  // O'quvchi muhitidagi NODE_OPTIONS (kod yuklash) va --inspect argumentlari Companion'ga ta'sir qilmasin. RunAsNode
  // qoladi: enroll.cmd uni ishlatadi (helper muhitni tozalaydi, process guard o'quvchi ochgan exe'ni o'ldiradi).
  test('the Companion exe has the NODE_OPTIONS and inspect fuses off', async () => {
    const out = await pack('x64');
    const exe = readZip(readFileSync(out)).find((e) => e.name === 'NetSchool Companion.exe')?.data ?? Buffer.alloc(0);
    const at = exe.indexOf(Buffer.from(FUSE_SENTINEL)) + FUSE_SENTINEL.length;
    expect(exe.subarray(at + 2, at + 11).toString('latin1')).toBe('100000011');
    expect(exe.subarray(0, 16).toString('latin1')).toBe('MZ electron x64 ');
    expect(exe.subarray(-5).toString('latin1')).toBe(' tail');
  });

  test('fuses are refused when the wire is missing, duplicated or unknown', () => {
    expect(() => flipFuses(Buffer.from('MZ no wire'))).toThrow(/fuse/);
    expect(() => flipFuses(Buffer.concat([fuseWire(), fuseWire()]))).toThrow(/fuse/);
    const v2 = fuseWire();
    v2[FUSE_SENTINEL.length] = 2;
    expect(() => flipFuses(v2)).toThrow(/fuse/);
    expect(() => flipFuses(fuseWire('10'))).toThrow(/fuse/);
    // Asl bufer o'zgarmaydi.
    const original = fuseWire();
    flipFuses(original);
    expect(original.subarray(FUSE_SENTINEL.length + 2).toString('latin1')).toBe('101100011');
  });
});
