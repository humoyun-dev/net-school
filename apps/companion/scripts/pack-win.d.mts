export const ELECTRON_VERSION: string;
export const KOFFI_VERSION: string;
export const FUSE_SENTINEL: string;
// electron.exe nusxasi: EnableNodeOptionsEnvironmentVariable va EnableNodeCliInspectArguments o'chiq.
export function flipFuses(exe: Buffer): Buffer;
export function packWin(opts: {
  arch: 'x64' | 'arm64';
  appDistDir: string;
  // `pnpm build:helper` natijasi: netschool-helper-windows-{amd64,arm64}.exe (yo'q bo'lsa paket yig'ilmaydi).
  helperDistDir: string;
  outDir: string;
  getElectronZip: (opts: { version: string; arch: string }) => Promise<Buffer>;
  // resources/app/node_modules/<name> ga ko'chiriladigan paketlar (koffi va @koromix/koffi-win32-<arch> majburiy).
  nodeModules: { name: string; dir: string }[];
  version?: string;
}): Promise<string>;
