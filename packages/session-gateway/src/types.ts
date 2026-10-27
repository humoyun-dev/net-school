import type { AuthorizedDesktopRequest } from '@netschool/domain';

export type RouteVerdict = { ok: true; upstreamPath: string } | { ok: false; reason: string };
export type FrameVerdict = { ok: true; data: string | Buffer } | { ok: false; reason: string };

// Upstream sessiyasi (MeshCentral'dan mustaqil): a'zolar adapterdagi MeshCentralViewerSession bilan bir xil.
export interface UpstreamViewerSession {
  readonly entryPath: string;
  attach(clientIp: string): Promise<void>;
  routeHttp(method: string, url: URL): RouteVerdict;
  routeWs(url: URL): RouteVerdict;
  requestHeaders(): Record<string, string>;
  absorbSetCookie(values: readonly string[]): void;
  rewriteHtml(url: URL, html: string): string;
  filterFrame(
    channel: 'control' | 'relay',
    direction: 'up' | 'down',
    data: string | Buffer,
    isBinary: boolean,
  ): FrameVerdict;
  revoke(): Promise<void>;
}

export interface ViewerUpstream {
  open(req: AuthorizedDesktopRequest): Promise<UpstreamViewerSession>;
}

export type GatewayEvent =
  | { type: 'ticket_rejected'; reason: 'unknown' | 'expired' }
  | { type: 'route_denied'; sessionId: string; kind: 'http' | 'ws'; path: string; reason: string }
  | {
      type: 'frame_dropped';
      sessionId: string;
      channel: 'control' | 'relay';
      direction: 'up' | 'down';
      reason: string;
    }
  | { type: 'upstream_error'; sessionId: string; message: string }
  | { type: 'session_closed'; sessionId: string; reason: 'revoked' | 'superseded' };
