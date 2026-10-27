// Upstream sessiya cookie'lari: nom bo'yicha oxirgi qiymat; atributlar e'tiborsiz, muddati o'tganlari o'chiriladi.
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  absorb(setCookie: readonly string[]): void {
    for (const line of setCookie) {
      const [pair = '', ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      if (name === '') continue;
      if (isExpired(attributes)) this.#cookies.delete(name);
      else this.#cookies.set(name, pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  has(name: string): boolean {
    return this.#cookies.has(name);
  }
}

function isExpired(attributes: readonly string[]): boolean {
  for (const attribute of attributes) {
    const eq = attribute.indexOf('=');
    if (eq < 0) continue;
    const key = attribute.slice(0, eq).trim().toLowerCase();
    const value = attribute.slice(eq + 1).trim();
    if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds <= 0) return true;
    } else if (key === 'expires') {
      const at = Date.parse(value);
      if (!Number.isNaN(at) && at <= Date.now()) return true;
    }
  }
  return false;
}
