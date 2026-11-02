import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

// Qurilma identiteti: Ed25519 kalit qurilmaning o'zida yaratiladi (ADR 0005). Private kalit rendererga berilmaydi.
export interface DeviceIdentity {
  deviceId: string;
  publicKey: string; // SPKI DER, base64url
  privateKey: KeyObject;
}

export type SignedHeaders = Record<'x-ns-device-id' | 'x-ns-timestamp' | 'x-ns-signature', string>;

export function generateDeviceKey(): { publicKey: string; privateKeyPem: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// Kalit egaligini isbotlaydi va uni tokenga bog'laydi: `NSCLAIM1\n<token>\n<publicKey>`.
export function claimProof(privateKey: KeyObject, token: string, publicKey: string): string {
  return sign(null, Buffer.from(`NSCLAIM1\n${token}\n${publicKey}`), privateKey).toString('base64url');
}

// Hub'dagi `deviceSigningInput` bilan bir xil format (testlar hub kodi bilan solishtiradi).
function signingInput(method: string, pathWithQuery: string, timestamp: string, rawBody: Buffer): Buffer {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return Buffer.from(`NSDEV1\n${method}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`);
}

// Har so'rov imzosi. Hub `ts > last_signed_ts` talab qiladi, shuning uchun timestamp jarayon ichida qat'iy o'sadi;
// qurilma soati noto'g'ri bo'lsa hub javobidagi `Date`dan olingan offset qo'shiladi.
export class RequestSigner {
  readonly #identity: DeviceIdentity;
  readonly #now: () => number;
  #offsetMs = 0;
  #last = 0;

  constructor(identity: DeviceIdentity, now: () => number = Date.now) {
    this.#identity = identity;
    this.#now = now;
  }

  sign(method: string, pathWithQuery: string, rawBody: Buffer): SignedHeaders {
    const ts = Math.max(Math.round(this.#now() + this.#offsetMs), this.#last + 1);
    this.#last = ts;
    const timestamp = String(ts);
    const signature = sign(null, signingInput(method, pathWithQuery, timestamp, rawBody), this.#identity.privateKey);
    return {
      'x-ns-device-id': this.#identity.deviceId,
      'x-ns-timestamp': timestamp,
      'x-ns-signature': signature.toString('base64url'),
    };
  }

  setClockOffset(ms: number): void {
    this.#offsetMs = ms;
  }
}
