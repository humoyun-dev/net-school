export const ELECTRON_VERSION: string;
export function packWin(opts: {
  arch: 'x64' | 'arm64';
  appDistDir: string;
  outDir: string;
  getElectronZip: (opts: { version: string; arch: string }) => Promise<Buffer>;
  version?: string;
}): Promise<string>;
