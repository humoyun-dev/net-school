import { Logger } from '@nestjs/common';
import type { DeviceManagementPort } from '@netschool/domain';
import { ApiError } from '../../common/errors.ts';

export const DEVICE_MANAGEMENT = Symbol('DEVICE_MANAGEMENT');

export interface SiteScope {
  meshInstanceId: string;
  meshDomainId: string;
}

// Site → scope xaritasi bilan adapter yaratadi; null — MeshCentral sozlanmagan.
export type DeviceManagementFactory = (scopes: ReadonlyMap<string, SiteScope>) => DeviceManagementPort;

const logger = new Logger('MeshCentral');

export function requirePort(
  factory: DeviceManagementFactory | null,
  meshInstanceId: string,
  site: { id: string; meshDomainId: string | null },
): { port: DeviceManagementPort; scope: SiteScope } {
  if (!factory || site.meshDomainId === null) {
    throw new ApiError('capability_unavailable', 'MeshCentral is not configured for this site');
  }
  const scope = { meshInstanceId, meshDomainId: site.meshDomainId };
  return { port: factory(new Map([[site.id, scope]])), scope };
}

// Adapter xatosi mijozga barqaror 503 bo'lib chiqadi; sababi faqat logda.
export async function upstream<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const code = (err as { code?: unknown }).code;
    logger.warn(`MeshCentral call failed${typeof code === 'string' ? `: ${code}` : ''}`);
    throw new ApiError('upstream_unavailable');
  }
}

// Adapter birinchi connect() muvaffaqiyatsiz bo'lsa qayta urinmaydi (qaror chaqiruvchida): API MeshCentral'siz
// ham ishga tushadi va fonda eksponensial kutish bilan ulanadi. Keyingi uzilishlarni adapter o'zi tiklaydi.
export function keepConnected(
  client: { connect(): Promise<void> },
  delays: { minDelayMs: number; maxDelayMs: number } = { minDelayMs: 1_000, maxDelayMs: 30_000 },
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const attempt = async (n: number) => {
    if (stopped) return;
    try {
      await client.connect();
      logger.log('Connected to MeshCentral');
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      logger.warn(`MeshCentral connection failed${typeof code === 'string' ? `: ${code}` : ''}; retrying`);
      if (!stopped)
        timer = setTimeout(() => void attempt(n + 1), Math.min(delays.maxDelayMs, delays.minDelayMs * 2 ** n));
    }
  };
  void attempt(0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
