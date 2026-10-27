import { randomBytes } from 'node:crypto';

export type CredentialKind = 'auth' | 'relay';

interface Pair {
  handle: string;
  real: string;
}

// Har tur uchun oxirgi 2 juftlik: yangilanish paytida oldingi handle hali ishlashi kerak.
const KEEP = 2;

// Brauzerga real MeshCentral cookie o'rniga opaque handle beriladi; real qiymat faqat shu yerda.
export class CredentialHandles {
  readonly #pairs: Record<CredentialKind, Pair[]> = { auth: [], relay: [] };

  remember(kind: CredentialKind, real: string): string {
    if (real === '') throw new Error('Empty credential cannot be remembered');
    const handle = `nsh_${randomBytes(24).toString('base64url')}`;
    const list = this.#pairs[kind];
    list.push({ handle, real });
    while (list.length > KEEP) list.shift();
    return handle;
  }

  resolve(kind: CredentialKind, handle: string): string | undefined {
    return this.#pairs[kind].find((pair) => pair.handle === handle)?.real;
  }

  reals(): readonly string[] {
    return [...this.#pairs.auth, ...this.#pairs.relay].map((pair) => pair.real);
  }
}
