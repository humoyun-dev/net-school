import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { AuthorizedDesktopRequest } from '@netschool/domain';
import {
  createGateway,
  type Gateway,
  type GatewayEvent,
  RemoteSessionBroker,
  SessionRegistry,
  TicketStore,
  type ViewerUpstream,
} from '@netschool/session-gateway';
import { CLOCK, type Clock } from '../../common/clock.ts';
import { API_CONFIG, type ApiConfig, meshHttpsOrigin } from '../../config/config.ts';

// MeshCentral tomoni (adapter main.ts'da ulanadi): viewer sessiyalari va qayta ishga tushishdagi principal tozalash.
export interface RemoteUpstream {
  viewer: ViewerUpstream;
  listPrincipals(): Promise<{ userId: string; sessionId: string }[]>;
  revokePrincipal(userId: string): Promise<void>;
}

// RemoteUpstream | null; null — MeshCentral sozlanmagan, gateway o'chiq.
export const REMOTE_GATEWAY = Symbol('REMOTE_GATEWAY');

interface Running {
  broker: RemoteSessionBroker;
  tickets: TicketStore;
  registry: SessionRegistry;
  gateway: Gateway;
  publicOrigin: string;
}

// P0b session gateway API jarayoni ichida: registry xotirada, shuning uchun revoke darhol (ADR 0003, ADR 0006).
// Ticket va cookie qiymatlari logga yozilmaydi; hodisalarda faqat sessiya id, yo'l va sabab bor.
@Injectable()
export class RemoteGateway implements OnModuleDestroy {
  readonly enabled: boolean;
  readonly #log = new Logger('RemoteGateway');
  readonly #running: Running | undefined;
  #listening = false;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(REMOTE_GATEWAY) upstream: RemoteUpstream | null,
    @Inject(CLOCK) now: Clock,
  ) {
    const { gateway, mesh } = config;
    this.enabled = upstream !== null && gateway !== null && mesh !== null;
    if (!upstream || !gateway || !mesh) return;
    const onEvent = (e: GatewayEvent) => this.#logEvent(e);
    const tickets = new TicketStore({ now });
    const registry = new SessionRegistry();
    const broker = new RemoteSessionBroker({ upstream: upstream.viewer, tickets, registry, onEvent });
    this.#running = {
      broker,
      tickets,
      registry,
      publicOrigin: gateway.publicOrigin,
      // Gateway TLS — API bilan bir xil sertifikat.
      gateway: createGateway({
        tls: config.tls,
        upstream: { origin: meshHttpsOrigin(mesh), ca: mesh.ca },
        publicOrigin: gateway.publicOrigin,
        broker,
        tickets,
        registry,
        onEvent,
      }),
    };
  }

  // Upstream sessiya ochiladi va registry'ga yoziladi; broker bergan birinchi ticket ishlatilmaydi —
  // ticket'lar issueTicket bilan talab bo'yicha beriladi.
  async open(req: AuthorizedDesktopRequest): Promise<void> {
    await this.#require().broker.open(req);
  }

  issueTicket(sessionId: string): { url: string; expiresAt: number } {
    const { tickets, publicOrigin } = this.#require();
    if (!this.isOpen(sessionId)) throw new Error(`Remote session is not open: ${sessionId}`);
    const { ticket, expiresAt } = tickets.issue(sessionId);
    return { url: `${publicOrigin}/rs/redeem?ticket=${ticket}`, expiresAt };
  }

  // Soketlar 1008 bilan yopiladi, keyin principal o'chiriladi; takroriy chaqiruv xavfsiz.
  async close(sessionId: string): Promise<void> {
    await this.#running?.broker.close(sessionId);
  }

  isOpen(sessionId: string): boolean {
    return this.#running?.registry.get(sessionId)?.closed === false;
  }

  async listen(port: number, host: string): Promise<number> {
    const bound = await this.#require().gateway.listen(port, host);
    this.#listening = true;
    this.#log.log(`Remote session gateway listening on ${host}:${bound}`);
    return bound;
  }

  async stop(): Promise<void> {
    if (!this.#running || !this.#listening) return;
    this.#listening = false;
    await this.#running.gateway.close();
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  #require(): Running {
    if (!this.#running) throw new Error('Remote session gateway is not enabled');
    return this.#running;
  }

  #logEvent(e: GatewayEvent): void {
    switch (e.type) {
      case 'ticket_rejected':
        this.#log.warn(`Ticket rejected: ${e.reason}`);
        break;
      case 'route_denied':
        this.#log.warn(`Route denied (${e.kind}) for session ${e.sessionId}: ${e.path} (${e.reason})`);
        break;
      case 'frame_dropped':
        this.#log.warn(`Frame dropped for session ${e.sessionId}: ${e.channel} ${e.direction} (${e.reason})`);
        break;
      case 'upstream_error':
        this.#log.error(`Upstream error for session ${e.sessionId}: ${e.message}`);
        break;
      case 'session_closed':
        this.#log.log(`Session ${e.sessionId} closed: ${e.reason}`);
        break;
    }
  }
}
