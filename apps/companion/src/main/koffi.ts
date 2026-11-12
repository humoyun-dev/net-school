// koffi'ning kerakli qismi (to'liq tip kerak emas; paket faqat Windows paketida yetkaziladi, bundle'dan tashqarida).
export interface Koffi {
  load(lib: string): { func(signature: string): (...args: unknown[]) => unknown };
  struct(name: string, fields: Record<string, string>): unknown;
  proto(signature: string): unknown;
  pointer(type: unknown): unknown;
  register(fn: (...args: never[]) => unknown, type: unknown): unknown;
  unregister(callback: unknown): void;
  decode(pointer: unknown, type: unknown): { vkCode: number; flags: number };
}

export function loadKoffi(): Koffi {
  // Tashqi native paket: yetishmasa xato tashlaydi.
  return require('koffi') as Koffi;
}
