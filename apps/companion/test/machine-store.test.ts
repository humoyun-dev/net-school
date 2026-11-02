import { sign, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { generateDeviceKey } from '../src/core/identity.ts';
import { type DeviceConfig, loadEnrollment, machineDir, saveEnrollment } from '../src/core/machine-store.ts';

const posix = process.platform !== 'win32';
const tempDir = () => mkdtempSync(join(tmpdir(), 'ns-companion-'));

function config(publicKey: string): DeviceConfig {
  return {
    hubOrigin: 'https://hub.school.lan',
    deviceId: '7d1f2a40-3c55-4b8e-9a61-0f2e8c4d5b6a',
    siteId: '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5',
    publicKey,
    enrolledAt: '2026-11-02T08:00:00.000Z',
  };
}

describe('machine store', () => {
  test('machine dir per platform with env override', () => {
    expect(machineDir('win32', { ProgramData: 'D:\\Data' })).toBe('D:\\Data\\NetSchool\\companion');
    expect(machineDir('win32', { PROGRAMDATA: 'E:\\PD' })).toBe('E:\\PD\\NetSchool\\companion');
    expect(machineDir('win32', {})).toBe('C:\\ProgramData\\NetSchool\\companion');
    expect(machineDir('darwin', {})).toBe('/Library/Application Support/NetSchool/companion');
    expect(machineDir('linux', {})).toBe('/var/lib/netschool/companion');
    expect(machineDir('freebsd', {})).toBe('/var/lib/netschool/companion');
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(machineDir(platform, { NETSCHOOL_COMPANION_DIR: '/tmp/ns', ProgramData: 'D:\\Data' })).toBe('/tmp/ns');
    }
  });

  test('a missing enrollment loads as null', () => {
    expect(loadEnrollment(join(tempDir(), 'absent'))).toBeNull();
    expect(loadEnrollment(tempDir())).toBeNull();
  });

  test('enrollment round-trips and a mismatched key is rejected', () => {
    const dir = join(tempDir(), 'companion');
    const key = generateDeviceKey();
    saveEnrollment(dir, { config: config(key.publicKey), privateKeyPem: key.privateKeyPem, ca: 'CA-PEM' });

    const loaded = loadEnrollment(dir);
    if (!loaded) throw new Error('enrollment did not load');
    expect(loaded.config).toEqual(config(key.publicKey));
    expect(loaded?.ca).toBe('CA-PEM');
    expect(loaded?.identity.deviceId).toBe(config(key.publicKey).deviceId);
    expect(loaded?.identity.publicKey).toBe(key.publicKey);
    // Yuklangan private kalit saqlangan public kalitga mos imzo beradi.
    const message = Buffer.from('ping');
    const signature = sign(null, message, loaded.identity.privateKey);
    expect(
      verify(null, message, { key: Buffer.from(key.publicKey, 'base64url'), format: 'der', type: 'spki' }, signature),
    ).toBe(true);
    if (posix) {
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      for (const file of ['device.json', 'device.key', 'hub-ca.pem']) {
        expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o644);
      }
    }

    // Qayta enroll CA'siz: eski CA fayli qolmaydi (aks holda eski CA'ga ishonilardi).
    saveEnrollment(dir, { config: config(key.publicKey), privateKeyPem: key.privateKeyPem, ca: null });
    expect(existsSync(join(dir, 'hub-ca.pem'))).toBe(false);
    expect(loadEnrollment(dir)?.ca).toBeNull();

    // device.json boshqa kalitni ko'rsatsa — xato, jimgina boshqa kalit bilan ishlamaydi.
    const other = generateDeviceKey();
    writeFileSync(join(dir, 'device.json'), JSON.stringify(config(other.publicKey)));
    expect(() => loadEnrollment(dir)).toThrow(/does not match/);
  });

  test('a corrupt device.json is an error, not a missing enrollment', () => {
    const dir = tempDir();
    const key = generateDeviceKey();
    saveEnrollment(dir, { config: config(key.publicKey), privateKeyPem: key.privateKeyPem, ca: null });
    writeFileSync(join(dir, 'device.json'), '{"hubOrigin":"http://hub.school.lan"}');
    expect(() => loadEnrollment(dir)).toThrow();
    expect(readFileSync(join(dir, 'device.key'), 'utf8')).toContain('PRIVATE KEY');
  });
});
