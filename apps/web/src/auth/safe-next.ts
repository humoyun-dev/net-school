// Faqat panel ichidagi yo'l (ochiq redirect yo'q): '/' bilan boshlanadi, '//' yoki '/\' emas.
export function safeNext(raw: string | null): string {
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}
