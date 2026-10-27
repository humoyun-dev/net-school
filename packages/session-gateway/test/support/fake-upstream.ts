import type { AuthorizedDesktopRequest } from '@netschool/domain';
import type { FrameVerdict, RouteVerdict, UpstreamViewerSession, ViewerUpstream } from '../../src/types.ts';

// Chaqiruvlar tartibini yozib boruvchi soxta upstream sessiya.
export class FakeUpstreamSession implements UpstreamViewerSession {
  entryPath = '/fake';
  revokeError: Error | undefined;
  revokeCalls = 0;
  attachError: Error | undefined;
  readonly attached: string[] = []; // attach(clientIp) chaqiruvlari
  httpVerdict: RouteVerdict = { ok: true, upstreamPath: '/' };
  routedHttp: Array<{ method: string; url: string }> = [];
  wsVerdict: RouteVerdict = { ok: true, upstreamPath: '/' };
  readonly routedWs: string[] = [];
  readonly frames: Array<{
    channel: 'control' | 'relay';
    direction: 'up' | 'down';
    data: string | Buffer;
    isBinary: boolean;
  }> = [];
  frameFilter:
    | ((
        channel: 'control' | 'relay',
        direction: 'up' | 'down',
        data: string | Buffer,
        isBinary: boolean,
      ) => FrameVerdict)
    | undefined;
  headers: Record<string, string> = {};
  headersError: Error | undefined;
  readonly absorbed: string[][] = [];
  rewrite: ((url: URL, html: string) => string) | undefined;
  closed = false; // revoke'dan keyin requestHeaders() bo'sh (haqiqiy adapterdagidek)

  constructor(readonly log: string[] = []) {}

  async attach(clientIp: string): Promise<void> {
    this.attached.push(clientIp);
    if (this.attachError) throw this.attachError;
  }
  routeHttp(method: string, url: URL): RouteVerdict {
    this.routedHttp.push({ method, url: url.pathname + url.search });
    return this.httpVerdict;
  }
  routeWs(url: URL): RouteVerdict {
    this.routedWs.push(url.pathname + url.search);
    return this.wsVerdict;
  }
  requestHeaders(): Record<string, string> {
    if (this.headersError) throw this.headersError;
    return this.closed ? {} : this.headers;
  }
  absorbSetCookie(values: readonly string[]): void {
    this.absorbed.push([...values]);
  }
  rewriteHtml(url: URL, html: string): string {
    return this.rewrite ? this.rewrite(url, html) : html;
  }
  filterFrame(
    channel: 'control' | 'relay',
    direction: 'up' | 'down',
    data: string | Buffer,
    isBinary: boolean,
  ): FrameVerdict {
    this.frames.push({ channel, direction, data, isBinary });
    return this.frameFilter ? this.frameFilter(channel, direction, data, isBinary) : { ok: true, data };
  }
  async revoke(): Promise<void> {
    this.revokeCalls++;
    this.closed = true;
    this.log.push('revoke');
    if (this.revokeError) throw this.revokeError;
  }
}

export class FakeViewerUpstream implements ViewerUpstream {
  openError: Error | undefined;
  readonly opened: AuthorizedDesktopRequest[] = [];
  readonly sessions: FakeUpstreamSession[] = [];
  nextRevokeError: Error | undefined; // keyingi ochiladigan sessiyaning revoke'i shu xato bilan tushadi

  async open(req: AuthorizedDesktopRequest): Promise<FakeUpstreamSession> {
    this.opened.push(req);
    if (this.openError) throw this.openError;
    const session = new FakeUpstreamSession();
    session.revokeError = this.nextRevokeError;
    this.nextRevokeError = undefined;
    this.sessions.push(session);
    return session;
  }
}

export class FakeSocket {
  readonly codes: Array<number | undefined> = [];
  constructor(private readonly log: string[] = []) {}
  close(code?: number): void {
    this.codes.push(code);
    this.log.push(`socket:${code}`);
  }
}
