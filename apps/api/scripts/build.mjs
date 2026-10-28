// API'ni bitta ESM faylga yig'adi: @netschool/* workspace paketlari ichiga, npm dependency'lar tashqarida qoladi.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@netschool/'));

await build({
  entryPoints: { main: join(root, 'src/main.ts') },
  outdir: join(root, 'dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  tsconfig: join(root, 'tsconfig.json'),
  external: [...external, ...external.map((name) => `${name}/*`)],
  logLevel: 'warning',
});
