import { describe, expect, test } from 'vitest';
import { capabilityReportSchema, claimRequestSchema, meshBindingRequestSchema } from '../src/index.ts';

const report = {
  protocolVersion: 1,
  os: 'linux',
  architecture: 'x64',
  desktopSession: 'x11',
  capabilities: { 'screen.view': { state: 'available' } },
};
const claim = {
  token: `nse_${'A'.repeat(43)}`,
  publicKey: 'MCowBQYDK2VwAyEA1234567890abcdefghijklmnopqrstuvwxyzABCDE',
  proof: 'c2lnbmF0dXJl',
  hostname: 'pc-01.school.lan',
  capabilities: report,
};

describe('device contracts', () => {
  test('claim rejects unknown fields and malformed token', () => {
    expect(claimRequestSchema.safeParse(claim).success).toBe(true);
    expect(claimRequestSchema.safeParse({ ...claim, siteId: 'x' }).success).toBe(false);
    expect(claimRequestSchema.safeParse({ ...claim, token: 'nse_short' }).success).toBe(false);
    expect(claimRequestSchema.safeParse({ ...claim, token: `xyz_${'A'.repeat(43)}` }).success).toBe(false);
    expect(claimRequestSchema.safeParse({ ...claim, publicKey: 'not base64url!' }).success).toBe(false);
    expect(claimRequestSchema.safeParse({ ...claim, hostname: 'bad\nhost' }).success).toBe(false);
  });

  test('capability report with 65 keys is rejected', () => {
    const many = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `cap.k${String.fromCharCode(97 + (i % 26))}${'x'.repeat(Math.floor(i / 26))}`,
          { state: 'available' },
        ]),
      );
    expect(capabilityReportSchema.safeParse({ ...report, capabilities: many(64) }).success).toBe(true);
    expect(capabilityReportSchema.safeParse({ ...report, capabilities: many(65) }).success).toBe(false);
  });

  test('mesh node id rejects slashes', () => {
    expect(meshBindingRequestSchema.safeParse({ meshNodeId: 'QVK8kiP0gqG8Jk$49nb@x' }).success).toBe(true);
    expect(meshBindingRequestSchema.safeParse({ meshNodeId: 'node//abc' }).success).toBe(false);
    expect(meshBindingRequestSchema.safeParse({ meshNodeId: '' }).success).toBe(false);
  });
});
