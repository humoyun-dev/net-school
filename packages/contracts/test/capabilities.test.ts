import { describe, expect, test } from 'vitest';
import { capabilityReportSchema } from '../src/index.ts';

// Spec §7 dagi namuna, aynan.
const specExample = {
  protocolVersion: 1,
  os: 'linux',
  architecture: 'arm64',
  desktopSession: 'wayland',
  capabilities: {
    'screen.view': { state: 'requires_permission', provider: 'portal' },
    'screen.control': { state: 'unsupported', reason: 'adapter_not_certified' },
    'classroom.overlay': { state: 'available', enforcement: 'soft' },
    'web.filter': { state: 'requires_setup', provider: 'managed_extension' },
  },
};

describe('capabilityReportSchema', () => {
  test('parses the spec §7 example', () => {
    const result = capabilityReportSchema.parse(specExample);
    expect(result.capabilities['screen.control']?.reason).toBe('adapter_not_certified');
  });

  test('rejects boolean capabilities', () => {
    const input = { ...specExample, capabilities: { 'screen.view': true } };
    expect(capabilityReportSchema.safeParse(input).success).toBe(false);
  });

  test('rejects unknown state', () => {
    const input = { ...specExample, capabilities: { 'screen.view': { state: 'maybe' } } };
    expect(capabilityReportSchema.safeParse(input).success).toBe(false);
  });

  test('rejects unsupported protocolVersion', () => {
    expect(capabilityReportSchema.safeParse({ ...specExample, protocolVersion: 2 }).success).toBe(false);
  });
});
