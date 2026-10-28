import { Injectable } from '@nestjs/common';
import type { Db } from '../../db/client.ts';
import { auditEvents } from '../../db/schema.ts';

export type AuditResult = 'allowed' | 'denied' | 'failed' | 'succeeded';

export interface AuditEntry {
  organizationId: string | null;
  siteId?: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  result: AuditResult;
  details?: Record<string, unknown>;
}

const MAX_DETAILS_BYTES = 4096;
const SECRET_KEY = /password|token|cookie|secret/i;

// Maxfiy kalitlar (ichki obyektlarda ham) olib tashlanadi.
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!SECRET_KEY.test(key)) out[key] = scrub(inner);
  }
  return out;
}

// Audit mutatsiya bilan bitta tranzaksiyada yoziladi: `tx` chaqiruvchining tranzaksiyasi.
@Injectable()
export class AuditWriter {
  async write(tx: Db, entry: AuditEntry, correlationId: string): Promise<void> {
    let details = scrub(entry.details ?? {}) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(details)) > MAX_DETAILS_BYTES) details = { truncated: true };
    await tx.insert(auditEvents).values({
      organizationId: entry.organizationId,
      siteId: entry.siteId ?? null,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      result: entry.result,
      correlationId,
      details,
    });
  }
}
