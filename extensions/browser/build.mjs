// Extension build: dist/ (unpacked, ishlab chiqish va do'konga yuklash uchun). Imzolashni do'kon bajaradi —
// repoda va hub'da extension kaliti yo'q (CLAUDE.md).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: { background: join(root, 'src/background.ts'), blocked: join(root, 'src/blocked.ts') },
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: false,
  legalComments: 'none',
});
copyFileSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));
copyFileSync(join(root, 'src/blocked.html'), join(dist, 'blocked.html'));
console.log(`extension: ${dist}`);
