import { randomBytes } from 'node:crypto';
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
  networks?: string[] | Record<string, { ipv4_address?: string } | null>;
  environment?: Record<string, string>;
  secrets?: string[];
  volumes?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] };
}
const services: Record<string, Service> = compose.services;
const initSql = readFileSync(join(here, '..', 'postgres', 'init', '01-databases.sh'), 'utf8');
// `${VAR:-default}` dagi standart qiymat.
const defaultOf = (value: string | undefined) => /:-([^}]*)\}/.exec(value ?? '')?.[1] ?? '';
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

  test('meshcentral trusts only the api address as proxy', () => {
    const apiNet = services.api?.networks as Record<string, { ipv4_address?: string }>;
    const apiIp = apiNet.hub?.ipv4_address;
    expect(apiIp).toMatch(/^\$\{API_IP:-/);
    expect(services.meshcentral?.environment?.MESHCENTRAL_TRUSTED_PROXY).toBe(apiIp);
    // Hamma servis bitta qat'iy subnet'da.
    for (const [name, service] of Object.entries(services)) {
      const nets = Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {});
      expect(nets, name).toEqual(['hub']);
    }
    // api'ning standart manzili subnet ichida, lekin dinamik diapazondan (boshqa konteynerlar) tashqarida.
    const [ipam] = compose.networks.hub.ipam.config as { subnet: string; ip_range: string }[];
    expect(defaultOf(ipam?.subnet)).toBe('172.31.250.0/24');
    expect(defaultOf(ipam?.ip_range)).toBe('172.31.250.128/25');
    expect(defaultOf(apiIp)).toBe('172.31.250.10');
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
    // Sinov qiymati ishga tushishda yaratiladi: repoda parolga o'xshash literal qolmaydi.
    const dbPassword = randomBytes(12).toString('hex');
    const config = renderConfig(template, {
      dbPassword,
      certName: 'hub.school.lan',
      trustedProxy: '172.31.250.10',
    });
    expect(config.settings.postgres).toEqual({
      host: 'postgres',
      port: 5432,
      user: 'meshcentral',
      password: dbPassword,
      database: 'meshcentral',
      // Database init skriptda yaratiladi; aks holda MeshCentral `postgres` DB'ga ulanmoqchi bo'ladi (db.js:961).
      createdatabase: false,
    });
    expect(config.settings.trustedProxy).toBe('172.31.250.10');
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

  test('trustedProxy is the given IP literal, never a DNS name', () => {
    const render = (trustedProxy?: string) =>
      renderConfig(template, { dbPassword: 'x', certName: 'meshcentral', trustedProxy });
    expect(render('10.20.30.40').settings.trustedProxy).toBe('10.20.30.40');
    // DNS nomini MeshCentral faqat ishga tushishda aniqlaydi (webserver.js:7216-7217) — api hali yo'q bo'lsa ENOTFOUND.
    expect(() => render('api')).toThrow(/MESHCENTRAL_TRUSTED_PROXY/);
    expect(() => render(undefined)).toThrow(/MESHCENTRAL_TRUSTED_PROXY/);
  });
  test('agent downloads stay offline: MeshCentral serves only the pinned agents baked into the image', () => {
    const config = renderConfig(template, { dbPassword: 'x', certName: 'meshcentral', trustedProxy: '172.31.250.10' });
    expect(config.settings.agentdownloads).toEqual({ enabled: false });
  });

  test('the lock records the pinned agent release of the upstream commit', () => {
    const lock = JSON.parse(readFileSync(join(here, '..', '..', 'meshcentral', 'upstream.lock.json'), 'utf8'));
    const defaults = JSON.parse(
      readFileSync(join(here, '..', '..', 'meshcentral', 'upstream', 'agents', 'agent-defaults.json'), 'utf8'),
    );
    const pinned = defaults.releases.map((r: { repository: string; tag: string; files: unknown[] }) => ({
      repository: r.repository,
      tag: r.tag,
      files: r.files.length,
    }));
    expect(lock.agentManifest.releases).toEqual(pinned);
    const all = defaults.releases.flatMap(
      (r: { files: { filename: string; sha384: string; size: number }[] }) => r.files,
    );
    for (const f of lock.agentManifest.windows) {
      expect(all.find((x: { filename: string }) => x.filename === f.name)).toMatchObject({
        sha384: f.sha384,
        size: f.bytes,
      });
    }
    expect(lock.agentManifest.windows.map((f: { id: number }) => f.id)).toEqual([4, 43]);
  });

  test('the meshcentral image bakes in the verified agent cache', () => {
    const dockerfile = readFileSync(join(here, '..', '..', 'meshcentral', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY infra/meshcentral/agent-cache/ ./agents/');
  });
  test('agent alias settings are rendered', () => {
    const config = renderConfig(template, {
      dbPassword: 'x',
      certName: 'meshcentral.hub.internal',
      trustedProxy: '172.31.250.10',
      agent: { port: 4433, aliasDns: 'hub.school.lan', aliasPort: 4433 },
    });
    expect(config.settings).toMatchObject({ agentPort: 4433, agentAliasDNS: 'hub.school.lan', agentAliasPort: 4433 });
  });

  test('agents need a dotted certificate name, otherwise MeshCentral silently goes LAN-only', () => {
    // meshcentral.js:1906 — CommonName'da nuqta bo'lmasa lanonly: .msh'ga MeshServer=local yoziladi.
    expect(() =>
      renderConfig(template, {
        dbPassword: 'x',
        certName: 'meshcentral',
        trustedProxy: '172.31.250.10',
        agent: { port: 4433, aliasDns: 'hub.school.lan', aliasPort: 4433 },
      }),
    ).toThrow(/MESHCENTRAL_CERT_NAME/);
  });

  test('an alias with a port or path is rejected', () => {
    for (const aliasDns of ['hub.lan:4433', 'hub.lan/agent', 'user@hub', '']) {
      expect(
        () =>
          renderConfig(template, {
            dbPassword: 'x',
            certName: 'meshcentral.hub.internal',
            trustedProxy: '172.31.250.10',
            agent: { port: 4433, aliasDns, aliasPort: 4433 },
          }),
        aliasDns,
      ).toThrow(/MESHCENTRAL_AGENT_ALIAS_DNS/);
    }
  });

  test('without agent settings nothing changes', () => {
    const config = renderConfig(template, { dbPassword: 'x', certName: 'meshcentral', trustedProxy: '172.31.250.10' });
    expect(config.settings.agentPort).toBeUndefined();
    expect(config.settings.agentAliasDNS).toBeUndefined();
  });

  test('the poc overlay publishes only the agent port of meshcentral', () => {
    const poc = parse(readFileSync(join(here, '..', 'compose.poc.yaml'), 'utf8'));
    const mc = poc.services.meshcentral as Service;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolatsiya sintaksisi
    expect(mc.ports).toEqual(['${MESH_AGENT_BIND:-0.0.0.0}:${MESH_AGENT_PORT:-4433}:4433']);
    expect(JSON.stringify(mc.ports)).not.toContain('4430');
    expect(mc.environment).toMatchObject({
      MESHCENTRAL_AGENT_PORT: '4433',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolatsiya sintaksisi
      MESHCENTRAL_AGENT_ALIAS_PORT: '${MESH_AGENT_PORT:-4433}',
    });
    expect(mc.environment?.MESHCENTRAL_AGENT_ALIAS_DNS).toMatch(/^\$\{MESH_AGENT_HOST:\?/);
    // Sertifikat nomi nuqtali (aks holda LAN-only), API shu nom bilan ulanadi; overlay boshqa port qo'shmaydi.
    expect(mc.environment?.MESHCENTRAL_CERT_NAME).toBe('meshcentral.hub.internal');
    expect(mc.networks).toEqual({ hub: { aliases: ['meshcentral.hub.internal'] } });
    const api = poc.services.api as Service;
    expect(api.environment).toEqual({ MESHCENTRAL_URL: 'wss://meshcentral.hub.internal:4430/control.ashx' });
    expect(api.ports).toBeUndefined();
    expect(Object.keys(poc.services).sort()).toEqual(['api', 'meshcentral']);
  });
});
