import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config/config.ts';

const base = {
  PUBLIC_ORIGIN: 'https://hub.school.lan',
  TLS_CERT: 'CERT',
  TLS_KEY: 'KEY',
  DATABASE_URL: 'postgres://u:p@db/netschool',
};

const mesh = {
  ...base,
  MESHCENTRAL_URL: 'wss://meshcentral:4430/control.ashx',
  MESHCENTRAL_USERNAME: 'netschool-api',
  MESHCENTRAL_PASSWORD: 'mc-secret-value',
  MESHCENTRAL_CA: 'MCCA',
};

function problemsOf(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (err) {
    return String(err);
  }
  return '';
}

describe('gateway config', () => {
  test('gateway requires a public origin when MeshCentral is configured', () => {
    expect(problemsOf(mesh)).toMatch(/GATEWAY_PUBLIC_ORIGIN/);
    for (const bad of ['http://hub.school.lan:8444', 'https://hub.school.lan:8444/rs', 'not a url']) {
      expect(problemsOf({ ...mesh, GATEWAY_PUBLIC_ORIGIN: bad })).toMatch(/GATEWAY_PUBLIC_ORIGIN/);
    }
    const config = loadConfig({ ...mesh, GATEWAY_PUBLIC_ORIGIN: 'https://hub.school.lan:8444' });
    expect(config.gateway).toEqual({ port: 8444, publicOrigin: 'https://hub.school.lan:8444' });
  });

  test('gateway port must differ from the API port', () => {
    const env = { ...mesh, GATEWAY_PUBLIC_ORIGIN: 'https://hub.school.lan:8444' };
    expect(problemsOf({ ...env, GATEWAY_PORT: '8443' })).toMatch(/GATEWAY_PORT/);
    expect(problemsOf({ ...env, API_PORT: '9000', GATEWAY_PORT: '9000' })).toMatch(/GATEWAY_PORT/);
    expect(problemsOf({ ...env, GATEWAY_PORT: 'abc' })).toMatch(/GATEWAY_PORT/);
    expect(problemsOf({ ...env, GATEWAY_PORT: '70000' })).toMatch(/GATEWAY_PORT/);
    expect(loadConfig({ ...env, GATEWAY_PORT: '9444' }).gateway?.port).toBe(9444);
  });

  test('no gateway without MeshCentral', () => {
    const config = loadConfig({ ...base, GATEWAY_PUBLIC_ORIGIN: 'https://hub.school.lan:8444', GATEWAY_PORT: '8443' });
    expect(config.mesh).toBeNull();
    expect(config.gateway).toBeNull();
  });
});

describe('secret files', () => {
  // MeshCentral entrypoint.sh service parolini xuddi shunday (trim) o'qiydi: ikki tomon bir xil parolni ko'radi.
  test('*_FILE values are trimmed of surrounding whitespace including CR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-config-'));
    try {
      const file = join(dir, 'meshcentral_service_password');
      writeFileSync(file, ' \tmc-secret value\r\n\n');
      const { MESHCENTRAL_PASSWORD: _, ...env } = mesh;
      const config = loadConfig({
        ...env,
        MESHCENTRAL_PASSWORD_FILE: file,
        GATEWAY_PUBLIC_ORIGIN: 'https://hub.school.lan:8444',
      });
      expect(config.mesh?.password).toBe('mc-secret value');
      writeFileSync(file, ' \r\n');
      expect(problemsOf({ ...env, MESHCENTRAL_PASSWORD_FILE: file })).toMatch(/MESHCENTRAL_PASSWORD is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
