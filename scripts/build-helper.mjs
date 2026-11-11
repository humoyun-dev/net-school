// Windows OS helper'ni ikki arxitektura uchun yig'adi: native/helper/dist/netschool-helper-windows-<arch>.exe.
// Versiya `git describe --tags --always --dirty` dan olinadi va ldflags orqali binary'ga yoziladi.
// macOS, Linux va Windows'da ishlaydi (Go cross-compile; CGO yo'q).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCHES = ['amd64', 'arm64'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const helperDir = join(root, 'native', 'helper');
const distDir = join(helperDir, 'dist');

function gitVersion() {
  const r = spawnSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: root, encoding: 'utf8' });
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v || 'dev';
}

function modulePath() {
  const m = /^module\s+(\S+)/m.exec(readFileSync(join(helperDir, 'go.mod'), 'utf8'));
  if (!m) throw new Error('native/helper/go.mod: module yo`li topilmadi');
  return m[1];
}

const version = gitVersion();
const ldflags = `-s -w -X ${modulePath()}/internal/version.Version=${version}`;
mkdirSync(distDir, { recursive: true });

for (const arch of ARCHES) {
  const out = join('dist', `netschool-helper-windows-${arch}.exe`);
  console.log(`build ${out} (${version})`);
  const r = spawnSync('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', out, './cmd/netschool-helper'], {
    cwd: helperDir,
    stdio: 'inherit',
    env: { ...process.env, GOOS: 'windows', GOARCH: arch, CGO_ENABLED: '0' },
  });
  if (r.error) {
    console.error(`go ishga tushmadi: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}
