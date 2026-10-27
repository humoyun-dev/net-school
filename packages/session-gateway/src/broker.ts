import type { AuthorizedDesktopRequest } from '@netschool/domain';
import type { SessionRegistry } from './registry.ts';
import type { TicketStore } from './tickets.ts';
import type { GatewayEvent, ViewerUpstream } from './types.ts';

export interface RemoteSessionBrokerOptions {
  upstream: ViewerUpstream;
  tickets: TicketStore;
  registry: SessionRegistry;
  onEvent?: (e: GatewayEvent) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class RemoteSessionBroker {
  readonly #opts: RemoteSessionBrokerOptions;

  constructor(opts: RemoteSessionBrokerOptions) {
    this.#opts = opts;
  }

  // Avval upstream sessiya, keyin ticket: upstream xatosida ticket berilmaydi.
  async open(req: AuthorizedDesktopRequest): Promise<{ sessionId: string; ticket: string; expiresAt: number }> {
    const { upstream, registry, tickets, onEvent } = this.#opts;
    let session: Awaited<ReturnType<ViewerUpstream['open']>>;
    try {
      session = await upstream.open(req);
    } catch (err) {
      onEvent?.({ type: 'upstream_error', sessionId: req.sessionId, message: messageOf(err) });
      throw err;
    }
    try {
      registry.add(req.sessionId, session);
    } catch (err) {
      // Ro'yxatga olinmagan upstream sessiya yetim qolmasin.
      await session.revoke().catch(() => {});
      throw err;
    }
    const { ticket, expiresAt } = tickets.issue(req.sessionId);
    return { sessionId: req.sessionId, ticket, expiresAt };
  }

  async close(sessionId: string): Promise<void> {
    const { registry, onEvent } = this.#opts;
    const wasOpen = registry.get(sessionId)?.closed === false;
    try {
      await registry.close(sessionId, 'revoked');
    } catch (err) {
      onEvent?.({ type: 'upstream_error', sessionId, message: messageOf(err) });
      if (wasOpen) onEvent?.({ type: 'session_closed', sessionId, reason: 'revoked' });
      throw err;
    }
    if (wasOpen) onEvent?.({ type: 'session_closed', sessionId, reason: 'revoked' });
  }
}
