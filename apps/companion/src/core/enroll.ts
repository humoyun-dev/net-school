import { createPrivateKey } from 'node:crypto';
import { claimResponseSchema } from '@netschool/contracts';
import { capabilityReport, type PlatformFacts } from './capabilities.ts';
import { HubClient } from './hub-client.ts';
import { claimProof, generateDeviceKey } from './identity.ts';
import { type DeviceConfig, enrollmentExists, ensureWritable, saveEnrollment } from './machine-store.ts';

export class EnrollError extends Error {
  readonly code: 'already_enrolled';

  constructor(code: 'already_enrolled', message: string) {
    super(message);
    this.name = 'EnrollError';
    this.code = code;
  }
}

// Hub `hostname`ni `[\x21-\x7e]{1,253}` deb talab qiladi: bo'sh joy va ASCII bo'lmagan belgilar almashtiriladi.
export function sanitizeHostname(raw: string): string {
  const cleaned = raw.replace(/[^\x21-\x7e]/g, '-').slice(0, 253);
  return cleaned || 'unknown';
}

export interface EnrollInput {
  hubOrigin: string;
  token: string;
  ca: string | null;
  hostname: string;
  facts: PlatformFacts;
  dir: string;
  force?: boolean;
}

// Qurilmada kalit yaratadi, bir martalik token bilan claim qiladi va natijani mashina katalogiga yozadi.
// Yozish faqat hub qabul qilgandan KEYIN: TLS yoki token xatosida diskda hech narsa qolmaydi.
export async function enroll(input: EnrollInput): Promise<DeviceConfig> {
  if (!input.force && enrollmentExists(input.dir)) {
    throw new EnrollError('already_enrolled', 'this computer is already enrolled; use --force to enroll it again');
  }
  // Hub'ga murojaatdan oldin: yozib bo'lmasa token sarflanmaydi va hub'da yetim qurilma qolmaydi.
  ensureWritable(input.dir);
  const key = generateDeviceKey();
  const proof = claimProof(createPrivateKey(key.privateKeyPem), input.token, key.publicKey);
  const hub = new HubClient({ origin: input.hubOrigin, ca: input.ca, signer: null });
  try {
    const claimed = await hub.json(
      'POST',
      '/api/v1/enrollments/claim',
      {
        token: input.token,
        publicKey: key.publicKey,
        proof,
        hostname: sanitizeHostname(input.hostname),
        capabilities: capabilityReport(input.facts),
      },
      claimResponseSchema,
    );
    const config: DeviceConfig = {
      hubOrigin: input.hubOrigin,
      deviceId: claimed.deviceId,
      siteId: claimed.siteId,
      publicKey: key.publicKey,
      enrolledAt: new Date().toISOString(),
    };
    saveEnrollment(input.dir, { config, privateKeyPem: key.privateKeyPem, ca: input.ca });
    return config;
  } finally {
    hub.close();
  }
}
