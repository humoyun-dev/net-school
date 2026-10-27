import type { AuthorizedDesktopRequest } from '@netschool/domain';
import type { MeshRequester } from '../control-client.ts';
import { AdapterError } from '../errors.ts';
import { MeshCentralPrincipals, type SessionPrincipal } from '../principals.ts';
import type { CookieJar } from './cookie-jar.ts';
import { CredentialHandles } from './credential-handles.ts';
import { loginPrincipal, type UpstreamEndpoint } from './upstream-login.ts';
import {
  type RouteVerdict,
  rewriteViewerHtml,
  routeViewerHttp,
  routeViewerWs,
  type ViewerContext,
  viewerEntryPath,
  type WsRouteVerdict,
} from './viewer-policy.ts';

export interface MeshCentralViewerUpstreamOptions {
  admin: MeshRequester;
  endpoint: UpstreamEndpoint;
  publicHost: string;
  login?: typeof loginPrincipal; // sinov uchun almashtiriladi; default: loginPrincipal
}

const CLOSED = { ok: false, reason: 'session_closed' } as const;

// Har sessiya uchun alohida principal yaratadi; admin ulanishi faqat shu yerda ishlatiladi.
export class MeshCentralViewerUpstream {
  readonly #opts: MeshCentralViewerUpstreamOptions;
  readonly #principals: MeshCentralPrincipals;

  constructor(opts: MeshCentralViewerUpstreamOptions) {
    this.#opts = opts;
    this.#principals = new MeshCentralPrincipals(opts.admin);
  }

  async open(req: AuthorizedDesktopRequest): Promise<MeshCentralViewerSession> {
    const principal = await this.#principals.create(req.device, req.mode);
    return new MeshCentralViewerSession(principal, req.mode, this.#opts, this.#principals);
  }
}

export class MeshCentralViewerSession {
  readonly entryPath: string;
  readonly #principal: SessionPrincipal;
  readonly #ctx: ViewerContext;
  readonly #endpoint: UpstreamEndpoint;
  readonly #publicHost: string;
  readonly #principals: MeshCentralPrincipals;
  readonly #loginFn: typeof loginPrincipal;
  #jar: CookieJar | undefined;
  #clientIp: string | undefined;
  #login: Promise<void> | undefined;
  // #closed: revoke() chaqirilgach sessiya butunlay yopiq; #deleted: deleteuser bajarildi (xato bo'lsa qayta uriniladi).
  #closed = false;
  #deleted: Promise<void> | undefined;

  constructor(
    principal: SessionPrincipal,
    mode: ViewerContext['mode'],
    opts: MeshCentralViewerUpstreamOptions,
    principals: MeshCentralPrincipals,
  ) {
    this.#principal = principal;
    this.#ctx = { nodeId: principal.nodeId, mode, handles: new CredentialHandles() };
    this.#endpoint = opts.endpoint;
    this.#publicHost = opts.publicHost;
    this.#principals = principals;
    this.#loginFn = opts.login ?? loginPrincipal;
    this.entryPath = viewerEntryPath(principal.nodeId);
  }

  // Birinchi chaqiruvda login; sessiya shu IP'ga bog'lanadi, boshqa IP rad etiladi.
  async attach(clientIp: string): Promise<void> {
    this.#assertOpen();
    if (this.#clientIp !== undefined && this.#clientIp !== clientIp) {
      throw new AdapterError('scope_denied', 'Viewer session is bound to another client IP');
    }
    if (!this.#login) {
      this.#clientIp = clientIp;
      this.#login = this.#loginFn(this.#endpoint, this.#principal, clientIp).then(
        (jar) => {
          // Login davomida revoke boshlangan bo'lsa, cookie saqlanmaydi.
          if (!this.#closed) this.#jar = jar;
        },
        (err: unknown) => {
          // Muvaffaqiyatsiz login keyingi urinishni to'smaydi.
          this.#login = undefined;
          this.#clientIp = undefined;
          throw err;
        },
      );
    }
    await this.#login;
    // Login kutilayotganda revoke boshlangan bo'lishi mumkin.
    this.#assertOpen();
  }

  routeHttp(method: string, url: URL): RouteVerdict {
    return this.#closed ? CLOSED : routeViewerHttp(method, url, this.#ctx);
  }

  // Filtr shu ulanishga bog'liq; sessiya yopilgach har kadr session_closed bilan rad etiladi.
  routeWs(url: URL): WsRouteVerdict {
    if (this.#closed) return CLOSED;
    const verdict = routeViewerWs(url, this.#ctx);
    if (!verdict.ok) return verdict;
    const inner = verdict.filter;
    return {
      ...verdict,
      filter: (direction, data, isBinary) => (this.#closed ? CLOSED : inner(direction, data, isBinary)),
    };
  }

  requestHeaders(): Record<string, string> {
    if (this.#closed) return {};
    if (!this.#jar || this.#clientIp === undefined) {
      throw new AdapterError('scope_denied', 'Viewer session is not attached');
    }
    return { cookie: this.#jar.header(), 'x-forwarded-for': this.#clientIp };
  }

  absorbSetCookie(values: readonly string[]): void {
    if (this.#closed) return;
    if (!this.#jar) throw new AdapterError('scope_denied', 'Viewer session is not attached');
    this.#jar.absorb(values);
  }

  rewriteHtml(url: URL, html: string): string {
    this.#assertOpen();
    return url.pathname === '/' ? rewriteViewerHtml(html, this.#ctx, this.#publicHost) : html;
  }

  // Birinchi chaqiruvdanoq sessiya butunlay yopiladi (deleteuser xato bersa ham); faqat deleteuser qayta uriniladi.
  revoke(): Promise<void> {
    this.#closed = true;
    this.#jar = undefined;
    this.#deleted ??= (async () => {
      await this.#login?.catch(() => {});
      this.#jar = undefined;
      await this.#principals.revoke(this.#principal.userId);
    })().catch((err: unknown) => {
      this.#deleted = undefined;
      throw err;
    });
    return this.#deleted;
  }

  #assertOpen(): void {
    if (this.#closed) throw new AdapterError('upstream_unavailable', 'Viewer session is closed');
  }
}
