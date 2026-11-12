import { urlPatternSchema } from '@netschool/contracts';

// Matn maydoni (har qatorda bitta sayt) → normallashgan patternlar yoki birinchi noto'g'ri qator.
export function parsePatterns(text: string): { patterns: string[]; invalid: string | null } {
  const patterns: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const parsed = urlPatternSchema.safeParse(line);
    if (!parsed.success) return { patterns: [], invalid: line };
    if (!patterns.includes(parsed.data)) patterns.push(parsed.data);
  }
  return { patterns, invalid: null };
}
