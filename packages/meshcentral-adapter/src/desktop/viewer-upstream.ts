import type { AuthorizedDesktopRequest } from '@netschool/domain';
import type { MeshRequester } from '../control-client.ts';
import { AdapterError } from '../errors.ts';
import { MeshCentralPrincipals, type SessionPrincipal } from '../principals.ts';
import type { CookieJar } from './cookie-jar.ts';
import { CredentialHandles } from './credential-handles.ts';
import { loginPrincipal, type UpstreamEndpoint } from './upstream-login.ts';
import {
  type FrameVerdict,
  filterControlDown,
  filterControlUp,
  filterRelayUp,
  type RouteVerdict,
  rewriteViewerHtml,
  routeViewerHttp,
  routeViewerWs,
  type ViewerContext,
  viewerEntryPath,
} from './viewer-policy.ts';

export interface MeshCentralViewerUpstreamOptions {
  admin: MeshRequester;
  endpoint: UpstreamEndpoint;
  publicHost: string;
}

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
  #jar: CookieJar | undefined;
  #clientIp: string | undefined;
  #login: Promise<void> | undefined;
  #revoked: Promise<void> | undefined;

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
    this.entryPath = viewerEntryPath(principal.nodeId);
  }

  // Birinchi chaqiruvda login; sessiya shu IP'ga bog'lanadi, boshqa IP rad etiladi.
  async attach(clientIp: string): Promise<void> {
    if (this.#revoked) throw new AdapterError('scope_denied', 'Viewer session is revoked');
    if (this.#clientIp !== undefined && this.#clientIp !== clientIp) {
      throw new AdapterError('scope_denied', 'Viewer session is bound to another client IP');
    }
    if (!this.#login) {
      this.#clientIp = clientIp;
      this.#login = loginPrincipal(this.#endpoint, this.#principal, clientIp).then(
        (jar) => {
          this.#jar = jar;
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
  }

  routeHttp(method: string, url: URL): RouteVerdict {
    return routeViewerHttp(method, url, this.#ctx);
  }

  routeWs(url: URL): RouteVerdict {
    return routeViewerWs(url, this.#ctx);
  }

  requestHeaders(): Record<string, string> {
    if (!this.#jar || this.#clientIp === undefined) {
      throw new AdapterError('scope_denied', 'Viewer session is not attached');
    }
    return { cookie: this.#jar.header(), 'x-forwarded-for': this.#clientIp };
  }

  absorbSetCookie(values: readonly string[]): void {
    if (!this.#jar) throw new AdapterError('scope_denied', 'Viewer session is not attached');
    this.#jar.absorb(values);
  }

  rewriteHtml(url: URL, html: string): string {
    return url.pathname === '/' ? rewriteViewerHtml(html, this.#ctx, this.#publicHost) : html;
  }

  filterFrame(
    channel: 'control' | 'relay',
    direction: 'up' | 'down',
    data: string | Buffer,
    isBinary: boolean,
  ): FrameVerdict {
    if (channel === 'relay') {
      return direction === 'up' ? filterRelayUp(data, isBinary, this.#ctx.mode) : { ok: true, data };
    }
    if (isBinary) return { ok: false, reason: 'control_binary' };
    const text = typeof data === 'string' ? data : data.toString('utf8');
    return direction === 'up' ? filterControlUp(text, this.#ctx) : filterControlDown(text, this.#ctx);
  }

  // Principal o'chirilishi control.ashx sessiyalarini ham yopadi; qayta chaqiruv no-op.
  revoke(): Promise<void> {
    this.#revoked ??= (async () => {
      await this.#login?.catch(() => {});
      await this.#principals.revoke(this.#principal.userId);
    })().catch((err: unknown) => {
      // O'chirish muvaffaqiyatsiz bo'lsa, qayta urinish mumkin.
      this.#revoked = undefined;
      throw err;
    });
    return this.#revoked;
  }
}
