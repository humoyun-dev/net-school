import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error — oddiy ESM skript, tiplarsiz
import { renderConfig } from '../../meshcentral/render-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const compose = parse(readFileSync(join(here, '..', 'compose.yaml'), 'utf8'));
const services: Record<string, { ports?: unknown[]; environment?: Record<string, string>; secrets?: string[] }> =
  compose.services;
const initSql = readFileSync(join(here, '..', 'postgres', 'init', '01-databases.sh'), 'utf8');
const template = JSON.parse(readFileSync(join(here, '..', '..', 'meshcentral', 'config.template.json'), 'utf8'));

describe('compose topology', () => {
  test('only the api publishes a port', () => {
    const published = Object.entries(services)
      .filter(([, s]) => (s.ports ?? []).length > 0)
      .map(([name]) => name);
    expect(published).toEqual(['api']);
    expect(services.api?.ports).toEqual(['443:8443']);
  });

  test('postgres and meshcentral publish nothing', () => {
    expect(services.postgres?.ports).toBeUndefined();
    expect(services.meshcentral?.ports).toBeUndefined();
  });

  test('no secret values appear in the compose file', () => {
    for (const [name, service] of Object.entries(services)) {
      for (const [key, value] of Object.entries(service.environment ?? {})) {
        if (/PASSWORD|_KEY|SECRET|DATABASE_URL|TLS_CERT/.test(key)) {
          expect(key, `${name}.${key}`).toMatch(/_FILE$/);
          expect(String(value), `${name}.${key}`).toMatch(/^\/run\/secrets\//);
        }
      }
    }
    for (const [name, secret] of Object.entries(compose.secrets as Record<string, { file: string }>)) {
      expect(secret.file, name).toMatch(/^\.\/secrets\//);
    }
  });

  test('meshcentral and api use different database users', () => {
    expect(services.api?.secrets).toContain('netschool_database_url');
    expect(services.api?.secrets).not.toContain('meshcentral_db_password');
    expect(services.meshcentral?.secrets).toEqual(['meshcentral_db_password']);
    expect(initSql).toMatch(/CREATE ROLE netschool LOGIN/);
    expect(initSql).toMatch(/CREATE ROLE meshcentral LOGIN/);
    expect(initSql).toMatch(/CREATE DATABASE netschool OWNER netschool/);
    expect(initSql).toMatch(/CREATE DATABASE meshcentral OWNER meshcentral/);
    expect(initSql).toMatch(/REVOKE CONNECT ON DATABASE netschool FROM PUBLIC/);
    expect(initSql).toMatch(/REVOKE CONNECT ON DATABASE meshcentral FROM PUBLIC/);
  });
});

describe('startup ordering', () => {
  test('postgres healthcheck uses TCP and migrations retry on failure', () => {
    const health = (compose.services.postgres.healthcheck.test as string[]).join(' ');
    expect(health).toContain('-h 127.0.0.1');
    expect(compose.services['api-migrate'].restart).toBe('on-failure');
  });

  test('README secret recipe produces URL-safe database passwords', () => {
    const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
    expect(readme).not.toMatch(/openssl rand -base64/);
    expect(readme).toMatch(/openssl rand -hex 32/);
  });
});

describe('meshcentral config rendering', () => {
  test('postgres settings use the meshcentral user and keep the hardened template', () => {
    const config = renderConfig(template, { dbPassword: 's3cret', certName: 'hub.school.lan' });
    expect(config.settings.postgres).toEqual({
      host: 'postgres',
      port: 5432,
      user: 'meshcentral',
      password: 's3cret',
      database: 'meshcentral',
      // Database init skriptda yaratiladi; aks holda MeshCentral `postgres` DB'ga ulanmoqchi bo'ladi (db.js:961).
      createdatabase: false,
    });
    for (const key of [
      'trustedProxy',
      'desktopMultiplex',
      'webRTC',
      'allowLoginToken',
      'cookieIpCheck',
      'maxInvalidLogin',
    ]) {
      expect(config.settings[key], key).toEqual(template.settings[key]);
    }
    expect(config.domains).toEqual(template.domains);
    expect(config.settings).toMatchObject({
      cert: 'hub.school.lan',
      port: 4430,
      redirPort: 0,
      selfUpdate: false,
      autoBackup: false,
    });
    expect(template.settings.postgres).toBeUndefined();
  });
});
