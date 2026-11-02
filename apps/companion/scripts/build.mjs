// Companion'ni yig'adi. Hamma narsa (zod, workspace paketlari) bitta faylga kiradi, shuning uchun `enroll`
// maktab kompyuterida node_modules'siz ishlaydi; faqat Electron tashqarida qoladi.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: { enroll: join(root, 'src/cli/enroll.ts') },
  outdir: join(root, 'dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  tsconfig: join(root, 'tsconfig.json'),
  external: ['electron'],
  logLevel: 'warning',
});
