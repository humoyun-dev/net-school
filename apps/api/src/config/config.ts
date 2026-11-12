import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export interface ApiConfig {
  port: number;
  host: string;
  publicOrigin: string;
  tls: { cert: string; key: string };
  databaseUrl: string;
  // null — MeshCentral ulanmagan; binding endpointlari 409 capability_unavailable.
  mesh: MeshConnection | null;
  // mesh_bindings'da yoziladigan barqaror instance nomi (node ID'lari faqat shu instance ichida unique).
  meshInstanceId: string;
  // Remote session gateway (ikkinchi HTTPS listener); mesh null bo'lsa null — gateway ishga tushmaydi.
  gateway: GatewayConfig | null;
  // Veb-panel build katalogi (index.html bilan); null — API panel bermaydi.
  webDistDir?: string | null;
  // P2c: do'kondagi NetSchool extension ID'lari (Helper forcelist'i uchun); null — hali chiqarilmagan.
  extensionIds?: { chrome: string | null; edge: string | null };
}

export interface GatewayConfig {
  port: number;
  // Brauzer viewer'ni ochadigan origin: ticket URL'i va WS Origin tekshiruvi shunga bog'liq.
  publicOrigin: string;
}

export interface MeshConnection {
  url: string;
  username: string;
  password: string;
  ca: string;
}

export const API_CONFIG = Symbol('API_CONFIG');

// zod url xatosidan keyin ham refine ishlaydi: parse qilinmaydigan qiymatda new URL() otilmasin.
const originSchema = z
  .url({ protocol: /^https$/ })
  .refine((v) => URL.canParse(v) && new URL(v).origin === v, 'must be a bare origin');

// *_FILE (Docker secrets) bo'lsa fayldan o'qiladi; boshi va oxiridagi bo'sh joy (\r\n ham) kesiladi — MeshCentral
// entrypoint.sh service parolini aynan shunday (String.prototype.trim) o'qiydi.
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return env[name];
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = read(env, name);
    if (!value) problems.push(`${name} is required`);
    return value ?? '';
  };

  const publicOrigin = need('PUBLIC_ORIGIN');
  if (publicOrigin && !originSchema.safeParse(publicOrigin).success) {
    problems.push('PUBLIC_ORIGIN must be an https origin without a path');
  }
  const cert = need('TLS_CERT');
  const key = need('TLS_KEY');
  const databaseUrl = need('DATABASE_URL');
  const meshUrl = read(env, 'MESHCENTRAL_URL');
  let mesh: MeshConnection | null = null;
  if (meshUrl) {
    if (!/^wss:\/\/[^/]+\/.+/.test(meshUrl)) problems.push('MESHCENTRAL_URL must be a wss:// URL');
    mesh = {
      url: meshUrl,
      username: need('MESHCENTRAL_USERNAME'),
      password: need('MESHCENTRAL_PASSWORD'),
      ca: need('MESHCENTRAL_CA'),
    };
  }
  const meshInstanceId = env.MESH_INSTANCE_ID ?? 'local';
  if (!/^[a-z0-9_-]{1,64}$/i.test(meshInstanceId))
    problems.push('MESH_INSTANCE_ID must be 1-64 letters, digits, _ or -');
  const port = Number(env.API_PORT ?? 8443);
  if (!isPort(port)) problems.push('API_PORT must be a port number');
  // Gateway faqat MeshCentral bilan: viewer sessiyalari shu upstream'ga proxy qilinadi.
  let gateway: GatewayConfig | null = null;
  if (mesh) {
    const gatewayOrigin = read(env, 'GATEWAY_PUBLIC_ORIGIN');
    if (!gatewayOrigin) problems.push('GATEWAY_PUBLIC_ORIGIN is required when MESHCENTRAL_URL is set');
    else if (!originSchema.safeParse(gatewayOrigin).success)
      problems.push('GATEWAY_PUBLIC_ORIGIN must be an https origin without a path');
    const gatewayPort = Number(env.GATEWAY_PORT ?? 8444);
    if (!isPort(gatewayPort)) problems.push('GATEWAY_PORT must be a port number');
    else if (gatewayPort === port) problems.push('GATEWAY_PORT must differ from API_PORT');
    gateway = { port: gatewayPort, publicOrigin: gatewayOrigin ?? '' };
  }

  const webDistDir = read(env, 'WEB_DIST_DIR') || null;
  if (webDistDir && !existsSync(join(webDistDir, 'index.html'))) problems.push('WEB_DIST_DIR must contain index.html');

  const extensionId = (name: string): string | null => {
    const value = read(env, name) || null;
    if (value !== null && !/^[a-p]{32}$/.test(value)) problems.push(`${name} must be a 32-letter extension id`);
    return value;
  };
  const extensionIds = {
    chrome: extensionId('NETSCHOOL_EXTENSION_ID_CHROME'),
    edge: extensionId('NETSCHOOL_EXTENSION_ID_EDGE'),
  };

  // Xabar faqat o'zgaruvchi nomlarini aytadi, qiymatlarni emas.
  if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  return {
    port,
    host: env.API_HOST ?? '0.0.0.0',
    publicOrigin,
    tls: { cert, key },
    databaseUrl,
    mesh,
    meshInstanceId,
    gateway,
    webDistDir,
    extensionIds,
  };
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

// MESHCENTRAL_URL (wss://host:port/control.ashx) dagi HTTPS origin: viewer sahifalari va WS shu yerdan proxy qilinadi.
export function meshHttpsOrigin(mesh: MeshConnection): string {
  return `https://${new URL(mesh.url).host}`;
}
