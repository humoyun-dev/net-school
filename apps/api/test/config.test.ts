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
