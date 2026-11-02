// Companion'ni yig'adi. Hamma narsa (zod, ws, workspace paketlari) fayllarga kiradi, shuning uchun `enroll` va ilova
// node_modules'siz ishlaydi; faqat Electron va ws'ning ixtiyoriy native qo'shimchalari tashqarida qoladi.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.NETSCHOOL_COMPANION_OUT || join(root, 'dist');
// Faqat e2e build: oynalarni ekranda ko'rsatmaydigan sinov rejimi. Oddiy build'da bu kod butunlay olib tashlanadi.
const testBuild = process.env.NETSCHOOL_COMPANION_TEST_BUILD === '1';
const tsconfig = join(root, 'tsconfig.json');
const common = { bundle: true, sourcemap: true, tsconfig, logLevel: 'warning' };
const external = ['electron', 'bufferutil', 'utf-8-validate'];

// enroll CLI: Node 24, ESM.
await build({
  ...common,
  entryPoints: { enroll: join(root, 'src/cli/enroll.ts') },
  outdir: dist,
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external,
  // Bundle ichidagi CJS paketlar (ws) uchun `require`.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// Asosiy jarayon CommonJS: Playwright (e2e) ESM entry'li Electron'ni ulay olmaydi.
await build({
  ...common,
  entryPoints: { main: join(root, 'src/main/main.ts') },
  outdir: dist,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external,
  define: { __NETSCHOOL_TEST_BUILD__: String(testBuild) },
  // Konstant shartlar yig'iladi: `false ? … : …` dagi sinov kodi bundle'ga kirmaydi.
  minifySyntax: true,
});

// Preload sandbox'da ishlaydi: CommonJS, faqat `electron`ni require qiladi.
await build({
  ...common,
  entryPoints: { preload: join(root, 'src/preload/preload.ts') },
  outdir: dist,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external,
});

// Renderer sahifalari: brauzer konteksti, har biri alohida ES modul (CSP: script-src 'self').
const rendererSrc = join(root, 'src/renderer');
const rendererOut = join(dist, 'renderer');
const pages = readdirSync(rendererSrc)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
  .map((f) => f.replace(/\.ts$/, ''));
await build({
  ...common,
  entryPoints: Object.fromEntries(pages.map((p) => [p, join(rendererSrc, `${p}.ts`)])),
  outdir: rendererOut,
  platform: 'browser',
  target: 'chrome140',
  format: 'esm',
});
mkdirSync(rendererOut, { recursive: true });
for (const f of readdirSync(rendererSrc)) {
  if (f.endsWith('.html') || f.endsWith('.css')) cpSync(join(rendererSrc, f), join(rendererOut, f));
}
