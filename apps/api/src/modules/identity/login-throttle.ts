// IP bo'yicha login urinishlari: oynada `limit`dan oshsa rad (xotirada, bitta jarayon uchun).
export class LoginThrottle {
  readonly #hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly now: () => number,
    private readonly limit = 30,
    private readonly windowMs = 60_000,
  ) {}

  hit(ip: string): boolean {
    const now = this.now();
    if (this.#hits.size > 10_000) {
      for (const [key, v] of this.#hits) if (now - v.windowStart >= this.windowMs) this.#hits.delete(key);
    }
    const entry = this.#hits.get(ip);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.#hits.set(ip, { windowStart: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }
}
