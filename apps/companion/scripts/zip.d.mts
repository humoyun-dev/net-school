export interface ZipEntry {
  name: string;
  data: Buffer;
}
export function readZip(buf: Buffer): ZipEntry[];
export function writeZip(entries: ZipEntry[]): Buffer;
