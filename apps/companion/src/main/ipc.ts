import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// `message:dismiss` argumenti: xabar identifikatori (UUID).
export const dismissArgSchema = z.uuid();

// IPC faqat ilovaning o'z renderer sahifalaridan qabul qilinadi: `file:` va renderer katalogi ichidagi yo'l.
// Prefiks hiylasi (`renderer-evil/`) va `..` yo'llari rad etiladi.
export function isTrustedSender(frameUrl: string | undefined, rendererRoot: string): boolean {
  if (!frameUrl) return false;
  let path: string;
  try {
    const url = new URL(frameUrl);
    if (url.protocol !== 'file:') return false;
    path = fileURLToPath(url);
  } catch {
    return false;
  }
  const rel = relative(resolve(rendererRoot), path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
