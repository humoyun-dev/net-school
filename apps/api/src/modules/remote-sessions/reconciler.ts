import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AdapterError } from '@netschool/meshcentral-adapter';
import { inArray } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { DB, type Db } from '../../db/client.ts';
import { remoteSessions } from '../../db/schema.ts';
import { AuditWriter } from '../audit/audit.writer.ts';
import { EventLog, Outbox } from '../events/event-log.ts';
import { WORKERS_ENABLED } from '../workers/outbox.worker.ts';
import { closeRemoteSessions } from './closing.ts';
import { REMOTE_UPSTREAM, type RemoteUpstream } from './remote-gateway.ts';

const INTERVAL_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DB va MeshCentral mosligi. Gateway registry xotirada: API qayta ishga tushsa hech bir sessiya tirik emas, shuning
// uchun startda yopilmagan hamma sessiya `restart` bilan yopiladi va hamma sessiya principal'i o'chiriladi. Davriy
// o'tishda faqat yopilgan yoki DB'da yo'q sessiyaning principal'i o'chiriladi. Principal'lar ro'yxatini adapter faqat
// `ns-sess-*` prefiksli user'lardan tuzadi — boshqa MeshCentral user'iga bu yerdan tegilmaydi.
@Injectable()
export class RemoteReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #log = new Logger('RemoteReconciler');
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(WORKERS_ENABLED) private readonly enabled: boolean,
    @Inject(REMOTE_UPSTREAM) private readonly upstream: RemoteUpstream | null,
    @Inject(EventLog) private readonly events: EventLog,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  // main.ts gateway.listen'ni app.listen'dan (ya'ni shu hook'dan) keyin chaqiradi: yangi sessiya ochilishidan oldin
  // eski holat tozalanadi.
  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    await this.#safeReconcile(true);
    this.#timer = setInterval(() => void this.#safeReconcile(false), INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.#timer);
  }

  async reconcile(
    now: number,
    opts: { startup: boolean },
  ): Promise<{ closedSessions: number; deletedPrincipals: number }> {
    // DB qismi MeshCentral holatiga bog'liq emas: upstream ishlamasa ham bajariladi.
    const closedSessions = opts.startup ? await this.#closeAll(now) : 0;
    const deletedPrincipals = await this.#deletePrincipals(opts.startup);
    return { closedSessions, deletedPrincipals };
  }

  async #closeAll(now: number): Promise<number> {
    const at = new Date(now);
    const closed = await this.db.transaction((tx) =>
      closeRemoteSessions(tx, { all: true }, 'restart', at, null, `reconcile-${randomUUID()}`, {
        events: this.events,
        outbox: this.outbox,
        audit: this.audit,
      }),
    );
    // Commit'dan keyin: revoke handler noma'lum gateway sessiyasi uchun no-op.
    if (closed.length > 0) this.outbox.kick();
    return closed.length;
  }

  async #deletePrincipals(all: boolean): Promise<number> {
    if (!this.upstream) return 0;
    let principals: { userId: string; sessionId: string }[];
    try {
      principals = await this.upstream.listPrincipals();
    } catch (err) {
      this.#log.warn(`Listing session principals failed: ${describe(err)}`);
      return 0;
    }
    // Ro'yxat DB so'rovidan oldin olinadi: ro'yxatdagi principal'ning sessiya qatori (opening) undan oldin commit
    // qilingan, shuning uchun "DB'da yo'q" haqiqatan noma'lum sessiya.
    const stale = all ? principals : await this.#withoutLiveSessions(principals);
    let deleted = 0;
    for (const { userId } of stale) {
      try {
        await this.upstream.revokePrincipal(userId);
        deleted += 1;
      } catch (err) {
        this.#log.warn(`Revoking a session principal failed: ${describe(err)}`);
      }
    }
    return deleted;
  }

  // `opening` va `active` sessiyalarning principal'i qoldiriladi.
  async #withoutLiveSessions(principals: { userId: string; sessionId: string }[]) {
    // UUID bo'lmagan sessiya id'si DB'da bo'lishi mumkin emas (uuid ustun uni rad etardi): noma'lum.
    const ids = [...new Set(principals.map((p) => p.sessionId).filter((id) => UUID.test(id)))];
    const rows = ids.length
      ? await this.db
          .select({ id: remoteSessions.id, status: remoteSessions.status })
          .from(remoteSessions)
          .where(inArray(remoteSessions.id, ids))
      : [];
    const live = new Set(rows.filter((r) => r.status !== 'closed').map((r) => r.id));
    return principals.filter((p) => !live.has(p.sessionId.toLowerCase()));
  }

  async #safeReconcile(startup: boolean): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.reconcile(this.now(), { startup });
    } catch (err) {
      this.#log.warn(`Remote reconciliation failed: ${describe(err)}`);
    } finally {
      this.#running = false;
    }
  }
}

// Faqat kod va xabar: AdapterError.detail upstream javobini olib yurishi mumkin.
function describe(err: unknown): string {
  if (err instanceof AdapterError) return err.code;
  return err instanceof Error ? err.message : String(err);
}
