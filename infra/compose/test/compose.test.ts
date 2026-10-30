import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
// @ts-expect-error — oddiy ESM skript, tiplarsiz
import { renderConfig } from '../../meshcentral/render-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const compose = parse(readFileSync(join(here, '..', 'compose.yaml'), 'utf8'));
interface Service {
  ports?: unknown[];
  environment?: Record<string, string>;
  secrets?: string[];
  volumes?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] };
}
const services: Record<string, Service> = compose.services;
const initSql = readFileSync(join(here, '..', 'postgres', 'init', '01-databases.sh'), 'utf8');
const template = JSON.parse(readFileSync(join(here, '..', '..', 'meshcentral', 'config.template.json'), 'utf8'));

describe('compose topology', () => {
  test('api publishes only 443 and the gateway port', () => {
    const published = Object.entries(services)
      .filter(([, s]) => (s.ports ?? []).length > 0)
      .map(([name]) => name);
    expect(published).toEqual(['api']);
    expect(services.api?.ports).toEqual(['443:8443', '8444:8444']);
    expect(services.api?.environment).toMatchObject({ API_PORT: '8443', GATEWAY_PORT: '8444' });
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
    expect(services.meshcentral?.secrets).toEqual(['meshcentral_db_password', 'meshcentral_service_password']);
    expect(initSql).toMatch(/CREATE ROLE netschool LOGIN/);
    expect(initSql).toMatch(/CREATE ROLE meshcentral LOGIN/);
    expect(initSql).toMatch(/CREATE DATABASE netschool OWNER netschool/);
    expect(initSql).toMatch(/CREATE DATABASE meshcentral OWNER meshcentral/);
    expect(initSql).toMatch(/REVOKE CONNECT ON DATABASE netschool FROM PUBLIC/);
    expect(initSql).toMatch(/REVOKE CONNECT ON DATABASE meshcentral FROM PUBLIC/);
  });
});

describe('api to meshcentral wiring', () => {
  test('api connects to meshcentral as the service account', () => {
    expect(services.api?.environment).toMatchObject({
      MESHCENTRAL_URL: 'wss://meshcentral:4430/control.ashx',
      MESHCENTRAL_USERNAME: 'netschool-svc',
      MESHCENTRAL_PASSWORD_FILE: '/run/secrets/meshcentral_service_password',
      MESHCENTRAL_CA_FILE: '/run/meshcentral-ca/root-cert-public.crt',
    });
    // Majburiy: berilmasa compose ishga tushmaydi (API ham MESHCENTRAL_URL bilan uni talab qiladi).
    expect(services.api?.environment?.GATEWAY_PUBLIC_ORIGIN).toMatch(/^\$\{GATEWAY_PUBLIC_ORIGIN:\?/);
    expect(services.api?.secrets).toContain('meshcentral_service_password');
    expect(services.meshcentral?.environment?.MESHCENTRAL_SERVICE_PASSWORD_FILE).toBe(
      '/run/secrets/meshcentral_service_password',
    );
  });

  test('api verifies meshcentral TLS against the certificate name', () => {
    // MeshCentral sertifikati faqat cert nomi (+ localhost) uchun; API hostname tekshiruvini o'chirmaydi.
    const url = new URL(services.api?.environment?.MESHCENTRAL_URL ?? '');
    expect(services.meshcentral?.environment?.MESHCENTRAL_CERT_NAME).toBe(url.hostname);
  });

  test('meshcentral private data is not mounted into api', () => {
    expect(services.api?.volumes).toEqual(['meshcentral-ca:/run/meshcentral-ca:ro']);
    expect(services.meshcentral?.volumes).toContain('meshcentral-ca:/run/meshcentral-ca');
    for (const name of ['api', 'api-migrate']) {
      const volumes = services[name]?.volumes ?? [];
      expect(
        volumes.some((v) => v.startsWith('meshcentral-data') || v.startsWith('meshcentral-files')),
        name,
      ).toBe(false);
    }
  });

  test('api waits for a healthy meshcentral', () => {
    expect(services.api?.depends_on?.meshcentral).toEqual({ condition: 'service_healthy' });
    const health = (services.meshcentral?.healthcheck?.test ?? []).join(' ');
    expect(health).toContain('/run/meshcentral-ca/root-cert-public.crt');
    expect(health).toContain('4430');
    expect(health).not.toMatch(/rejectUnauthorized/);
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
    expect(readme).toMatch(/secrets\/meshcentral_service_password/);
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
    // Gateway api konteynerida: MeshCentral bitta satrli qiymatni DNS orqali IP'ga aylantiradi (webserver.js:7216-7217).
    expect(config.settings.trustedProxy).toBe('api');
    expect(template.settings.trustedProxy).toBe('127.0.0.1');
    for (const key of ['desktopMultiplex', 'webRTC', 'allowLoginToken', 'cookieIpCheck', 'maxInvalidLogin']) {
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
