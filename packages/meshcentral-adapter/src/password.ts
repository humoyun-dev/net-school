import { randomBytes } from 'node:crypto';

// 256 bit entropiya; "-Aa1" qat'iy passwordRequirements uchun har sinfdan belgi kafolatlaydi.
export function generateMeshPassword(): string {
  return `${randomBytes(32).toString('base64url')}-Aa1`;
}
