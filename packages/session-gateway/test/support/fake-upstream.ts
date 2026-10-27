import type { AuthorizedDesktopRequest } from '@netschool/domain';
import type {
  FrameVerdict,
  RouteVerdict,
  UpstreamViewerSession,
  ViewerUpstream,
  WsRouteVerdict,
} from '../../src/types.ts';

// Chaqiruvlar tartibini yozib boruvchi soxta upstream sessiya.
export class FakeUpstreamSession implements UpstreamViewerSession {
  entryPath = '/fake';
  revokeError: Error | undefined;
  revokeHang = false; // true: revoke() hech qachon tugamaydi
  revokeCalls = 0;
  attachError: Error | undefined;
  readonly attached: string[] = []; // attach(clientIp) chaqiruvlari
  httpVerdict: RouteVerdict = { ok: true, upstreamPath: '/' };
  routedHttp: Array<{ method: string; url: string }> = [];
  wsVerdict: RouteVerdict = { ok: true, upstreamPath: '/' }; // routeWs bunga ulanish filtrini qo'shadi
  readonly routedWs: string[] = [];
  readonly filterCalls: number[] = []; // routeWs bergan har filtr (ulanish) necha marta chaqirilgani
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
  routeWs(url: URL): WsRouteVerdict {
    this.routedWs.push(url.pathname + url.search);
    const verdict = this.wsVerdict;
    if (!verdict.ok) return verdict;
    const channel = url.pathname === '/meshrelay.ashx' ? 'relay' : 'control';
    const index = this.filterCalls.push(0) - 1;
    const filter = (direction: 'up' | 'down', data: string | Buffer, isBinary: boolean): FrameVerdict => {
      this.filterCalls[index] = (this.filterCalls[index] ?? 0) + 1;
      this.frames.push({ channel, direction, data, isBinary });
      return this.frameFilter ? this.frameFilter(channel, direction, data, isBinary) : { ok: true, data };
    };
    return { ...verdict, filter };
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
  async revoke(): Promise<void> {
    this.revokeCalls++;
    this.closed = true;
    this.log.push('revoke');
    if (this.revokeHang) await new Promise<never>(() => {});
    if (this.revokeError) throw this.revokeError;
  }
}

export class FakeViewerUpstream implements ViewerUpstream {
  openError: Error | undefined;
  readonly opened: AuthorizedDesktopRequest[] = [];
  readonly sessions: FakeUpstreamSession[] = [];
  nextRevokeError: Error | undefined; // keyingi ochiladigan sessiyaning revoke'i shu xato bilan tushadi
  nextRevokeHang = false; // keyingi ochiladigan sessiyaning revoke'i hech qachon tugamaydi

  async open(req: AuthorizedDesktopRequest): Promise<FakeUpstreamSession> {
    this.opened.push(req);
    if (this.openError) throw this.openError;
    const session = new FakeUpstreamSession();
    session.revokeError = this.nextRevokeError;
    session.revokeHang = this.nextRevokeHang;
    this.nextRevokeError = undefined;
    this.nextRevokeHang = false;
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
