import type { AuthorizedDesktopRequest } from '@netschool/domain';
import type { FrameVerdict, RouteVerdict, UpstreamViewerSession, ViewerUpstream } from '../../src/types.ts';

// Chaqiruvlar tartibini yozib boruvchi soxta upstream sessiya.
export class FakeUpstreamSession implements UpstreamViewerSession {
  readonly entryPath = '/fake';
  revokeError: Error | undefined;
  revokeCalls = 0;

  constructor(readonly log: string[] = []) {}

  async attach(): Promise<void> {}
  routeHttp(): RouteVerdict {
    return { ok: true, upstreamPath: '/' };
  }
  routeWs(): RouteVerdict {
    return { ok: true, upstreamPath: '/' };
  }
  requestHeaders(): Record<string, string> {
    return {};
  }
  absorbSetCookie(): void {}
  rewriteHtml(_url: URL, html: string): string {
    return html;
  }
  filterFrame(_c: 'control' | 'relay', _d: 'up' | 'down', data: string | Buffer): FrameVerdict {
    return { ok: true, data };
  }
  async revoke(): Promise<void> {
    this.revokeCalls++;
    this.log.push('revoke');
    if (this.revokeError) throw this.revokeError;
  }
}

export class FakeViewerUpstream implements ViewerUpstream {
  openError: Error | undefined;
  readonly opened: AuthorizedDesktopRequest[] = [];
  readonly sessions: FakeUpstreamSession[] = [];

  async open(req: AuthorizedDesktopRequest): Promise<FakeUpstreamSession> {
    this.opened.push(req);
    if (this.openError) throw this.openError;
    const session = new FakeUpstreamSession();
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
