import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const template = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../infra/meshcentral/config.template.json'), 'utf8'),
);
const s = template.settings;
const d = template.domains[''];

describe('MeshCentral config template', () => {
  test('template keeps security-critical settings', () => {
    expect(s.trustedProxy).toBe('127.0.0.1');
    expect(s.desktopMultiplex).toBe(false);
    expect(s.webRTC).toBe(false);
    expect(s.allowLoginToken).toBe(false);
    expect(s.allowFraming).toBe(false);
    expect(s.cookieIpCheck).toBe('strict');
    expect(s.maxInvalidLogin).toEqual({
      time: 10,
      count: 10,
      coolofftime: 10,
      blocking: 'ip',
      exclude: '127.0.0.1,::1',
    });
  });

  test('default domain grants nothing to new accounts', () => {
    expect(d.newAccounts).toBe(false);
    expect(d).not.toHaveProperty('newAccountsUserGroups');
    expect(d).not.toHaveProperty('newAccountsRights');
    expect(d.passwordRequirements).toEqual({
      min: 16,
      max: 128,
      upper: 1,
      lower: 1,
      numeric: 1,
      nonalpha: 1,
      loginTokens: false,
    });
  });
});
