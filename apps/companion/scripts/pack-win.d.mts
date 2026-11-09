export const ELECTRON_VERSION: string;
export const KOFFI_VERSION: string;
export function packWin(opts: {
  arch: 'x64' | 'arm64';
  appDistDir: string;
  outDir: string;
  getElectronZip: (opts: { version: string; arch: string }) => Promise<Buffer>;
  // resources/app/node_modules/<name> ga ko'chiriladigan paketlar (koffi va @koromix/koffi-win32-<arch> majburiy).
  nodeModules: { name: string; dir: string }[];
  version?: string;
}): Promise<string>;
