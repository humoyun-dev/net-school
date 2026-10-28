import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

// Faqat Ed25519 SPKI DER, kanonik kodlashda (bir kalit — bitta fingerprint).
export function parseDevicePublicKey(spkiB64url: string): KeyObject | null {
  const der = Buffer.from(spkiB64url, 'base64url');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
  if (key.asymmetricKeyType !== 'ed25519') return null;
  if (!key.export({ type: 'spki', format: 'der' }).equals(der)) return null;
  return key;
}

export function keyFingerprint(spkiDer: Buffer): string {
  return createHash('sha256').update(spkiDer).digest('hex');
}

export function verifySignature(key: KeyObject, message: Buffer, signatureB64url: string): boolean {
  try {
    return verify(null, message, key, Buffer.from(signatureB64url, 'base64url'));
  } catch {
    return false;
  }
}

// Kalit egaligini isbotlaydi va token bilan bog'laydi.
export function verifyClaimProof(key: KeyObject, token: string, publicKey: string, proof: string): boolean {
  return verifySignature(key, Buffer.from(`NSCLAIM1\n${token}\n${publicKey}`), proof);
}

export function deviceSigningInput(method: string, pathWithQuery: string, timestamp: string, rawBody: Buffer): Buffer {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return Buffer.from(`NSDEV1\n${method}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`);
}
