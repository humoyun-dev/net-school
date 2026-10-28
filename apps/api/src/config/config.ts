import { readFileSync } from 'node:fs';
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
}

export interface MeshConnection {
  url: string;
  username: string;
  password: string;
  ca: string;
}

export const API_CONFIG = Symbol('API_CONFIG');

const originSchema = z.url({ protocol: /^https$/ }).refine((v) => new URL(v).origin === v, 'must be a bare origin');

// *_FILE (Docker secrets) bo'lsa fayldan o'qiladi; oxiridagi bo'sh joy kesiladi.
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
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push('API_PORT must be a port number');

  // Xabar faqat o'zgaruvchi nomlarini aytadi, qiymatlarni emas.
  if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  return { port, host: env.API_HOST ?? '0.0.0.0', publicOrigin, tls: { cert, key }, databaseUrl, mesh, meshInstanceId };
}
