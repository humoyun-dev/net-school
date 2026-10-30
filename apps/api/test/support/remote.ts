import type { AuthorizedDesktopRequest } from '@netschool/domain';
import type { UpstreamViewerSession } from '@netschool/session-gateway';
import type { Db } from '../../src/db/client.ts';
import { meshBindings } from '../../src/db/schema.ts';
import type { RemoteUpstream } from '../../src/modules/remote-sessions/remote-gateway.ts';

// Faqat ochish/yopish uchun kerakli a'zolar; proxy yo'llari ishlatilmaydi.
export class FakeViewerSession implements UpstreamViewerSession {
  readonly entryPath = '/viewer/entry';
  revokeCalls = 0;
  // Keyingi shuncha revoke xato bilan tugaydi (qayta urinish testlari).
  revokeFailures = 0;
  // Berilsa revoke shu va'dani kutadi (timeout testlari).
  revokeHold: Promise<void> | undefined;

  async attach(): Promise<void> {}
  routeHttp() {
    return { ok: false as const, reason: 'unused' };
  }
  routeWs() {
    return { ok: false as const, reason: 'unused' };
  }
  requestHeaders(): Record<string, string> {
    return {};
  }
  absorbSetCookie(): void {}
  rewriteHtml(_url: URL, html: string): string {
    return html;
  }
  async revoke(): Promise<void> {
    this.revokeCalls++;
    if (this.revokeHold) await this.revokeHold;
    if (this.revokeFailures > 0) {
      this.revokeFailures--;
      throw new Error('revoke rejected');
    }
  }
}

// MeshCentral viewer o'rnida: ochilgan principal so'rovlari va sessiyalari yozib boriladi.
export class FakeRemote {
  readonly opened: AuthorizedDesktopRequest[] = [];
  readonly sessions = new Map<string, FakeViewerSession>();
  // true — adduser/ulanish rad etilgandek xato.
  failing = false;
  // Upstream sessiya yaratilishidan oldin chaqiriladi (poyga testlari uchun).
  onOpen: ((req: AuthorizedDesktopRequest) => Promise<void>) | undefined;

  readonly upstream: RemoteUpstream = {
    viewer: {
      open: async (req) => {
        this.opened.push(req);
        if (this.onOpen) await this.onOpen(req);
        if (this.failing) throw new Error('adduser rejected');
        const session = new FakeViewerSession();
        this.sessions.set(req.sessionId, session);
        return session;
      },
    },
    listPrincipals: async () => [],
    revokePrincipal: async () => {},
  };

  reset(): void {
    this.opened.length = 0;
    this.sessions.clear();
    this.failing = false;
    this.onOpen = undefined;
  }
}

export async function seedBinding(
  db: Db,
  b: { orgId: string; siteId: string; deviceId: string; meshDomainId: string; meshNodeId: string; boundBy: string },
): Promise<void> {
  await db.insert(meshBindings).values({
    deviceId: b.deviceId,
    organizationId: b.orgId,
    siteId: b.siteId,
    meshInstanceId: 'local',
    meshDomainId: b.meshDomainId,
    meshNodeId: b.meshNodeId,
    boundBy: b.boundBy,
  });
}
