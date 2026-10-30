import { randomUUID } from 'node:crypto';
import type { CloseReason } from '@netschool/domain';
import { and, asc, eq, inArray, lte, ne, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { controlLeases, remoteSessions } from '../../db/schema.ts';
import type { AuditWriter } from '../audit/audit.writer.ts';
import type { EventLog, Outbox } from '../events/event-log.ts';

export type SessionFilter =
  | { lessonId: string }
  | { deviceId: string }
  | { sessionId: string }
  | { expiredAt: Date }
  // Hamma yopilmagan sessiyalar: qayta ishga tushishda (gateway xotirasi bo'sh).
  | { all: true };

function matching(filter: SessionFilter): SQL {
  if ('lessonId' in filter) return eq(remoteSessions.lessonId, filter.lessonId);
  if ('deviceId' in filter) return eq(remoteSessions.deviceId, filter.deviceId);
  if ('sessionId' in filter) return eq(remoteSessions.id, filter.sessionId);
  if ('all' in filter) return sql`true`;
  return lte(remoteSessions.expiresAt, filter.expiredAt);
}

// Modul DI'siz: dars yopilishi, qurilma chiqishi, maintenance va ochish xatosi shu yerdan yopadi.
// Chaqiruvchining tranzaksiyasida: sessiya qatorlari, keyin xona lock'i (EventLog) — chaqiruvchi o'z xona
// voqeasini shundan keyin yozadi, aks holda aktivatsiya (sessiya → xona) bilan deadlock bo'lishi mumkin.
// Commit'dan keyin chaqiruvchining Outbox.kick()i: gateway soketlari darhol (outbox'ni kutmasdan) uziladi, principal esa
// outbox `remote.revoke` orqali qayta urinish bilan o'chiriladi.
export async function closeRemoteSessions(
  tx: Db,
  filter: SessionFilter,
  reason: CloseReason,
  at: Date,
  closedBy: string | null,
  correlationId: string | null,
  deps: { events: EventLog; outbox: Outbox; audit: AuditWriter },
): Promise<string[]> {
  const open = await tx
    .select()
    .from(remoteSessions)
    .where(and(matching(filter), ne(remoteSessions.status, 'closed')))
    .orderBy(asc(remoteSessions.id))
    .for('update');
  if (open.length === 0) return [];
  const ids = open.map((s) => s.id);
  await tx
    .update(remoteSessions)
    .set({ status: 'closed', closedAt: at, closeReason: reason, closedBy })
    .where(inArray(remoteSessions.id, ids));
  // Yopilgan sessiya lease ushlamaydi: qurilma darhol boshqa controller uchun bo'sh.
  await tx.delete(controlLeases).where(inArray(controlLeases.sessionId, ids));
  deps.outbox.sessionsClosed(ids);

  await deps.events.lockRooms(
    tx,
    open.map((s) => s.roomId),
  );
  const correlation = correlationId ?? randomUUID();
  for (const s of open) {
    await deps.events.append(tx, {
      organizationId: s.organizationId,
      siteId: s.siteId,
      roomId: s.roomId,
      lessonId: s.lessonId,
      type: 'remote_session.closed',
      data: { sessionId: s.id, deviceId: s.deviceId, mode: s.mode, reason },
    });
    await deps.outbox.enqueue(tx, s.organizationId, 'remote.revoke', { sessionId: s.id });
    await deps.audit.write(
      tx,
      {
        organizationId: s.organizationId,
        siteId: s.siteId,
        actorUserId: closedBy,
        action: 'remote_session.close',
        targetType: 'remote_session',
        targetId: s.id,
        result: 'succeeded',
        details: { reason },
      },
      correlation,
    );
  }
  const byOrg = new Map<string, Set<string>>();
  for (const s of open) byOrg.set(s.organizationId, (byOrg.get(s.organizationId) ?? new Set()).add(s.roomId));
  for (const [organizationId, roomIds] of byOrg) {
    await deps.outbox.enqueue(tx, organizationId, 'notify.rooms', { roomIds: [...roomIds].sort() });
  }
  return ids;
}
