import type { IncomingHttpHeaders } from 'node:http';
import { request } from 'node:https';
import type { AuthorizedDesktopRequest } from '@netschool/domain';
import type { UpstreamViewerSession, ViewerUpstream } from '@netschool/session-gateway';
import { afterEach, describe, expect, test } from 'vitest';
import { RemoteGateway, type RemoteUpstream } from '../src/modules/remote-sessions/remote-gateway.ts';
import { startTestApp, type TestApp } from './support/app.ts';

// Faqat redeem va yopilish uchun kerakli a'zolar; proxy yo'llari ishlatilmaydi.
class FakeSession implements UpstreamViewerSession {
  readonly entryPath = '/viewer/entry';
  readonly attached: string[] = [];
  revokeCalls = 0;

  async attach(clientIp: string): Promise<void> {
    this.attached.push(clientIp);
  }
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
  }
}

function fakeUpstream(): RemoteUpstream & { sessions: Map<string, FakeSession> } {
  const sessions = new Map<string, FakeSession>();
  const viewer: ViewerUpstream = {
    async open(req) {
      const session = new FakeSession();
      sessions.set(req.sessionId, session);
      return session;
    },
  };
  return { viewer, sessions, listPrincipals: async () => [], revokePrincipal: async () => {} };
}

const desktop = (sessionId: string): AuthorizedDesktopRequest => ({
  sessionId,
  actorId: 'teacher-1',
  device: { meshInstanceId: 'local', meshDomainId: '', meshNodeId: 'abc' },
  mode: 'view',
});

function get(port: number, ca: string, path: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, servername: 'localhost', ca, method: 'GET', path }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

let app: TestApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('remote gateway', () => {
  test('issued ticket redeems once to the viewer entry', async () => {
    const upstream = fakeUpstream();
    app = await startTestApp({ remote: upstream });
    const gateway = app.get<RemoteGateway>(RemoteGateway);
    expect(gateway.enabled).toBe(true);
    const port = await gateway.listen(0, '127.0.0.1');

    await gateway.open(desktop('rs-1'));
    expect(gateway.isOpen('rs-1')).toBe(true);
    const { url, expiresAt } = gateway.issueTicket('rs-1');
    const issued = new URL(url);
    expect(issued.pathname).toBe('/rs/redeem');
    expect(issued.searchParams.get('ticket')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const path = `${issued.pathname}${issued.search}`;
    const first = await get(port, app.ca, path);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/viewer/entry');
    expect(first.headers['set-cookie']?.[0]).toMatch(/^__Host-ns_rs=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\//);
    expect(upstream.sessions.get('rs-1')?.attached).toEqual(['127.0.0.1']);

    const second = await get(port, app.ca, path);
    expect(second.status).toBe(403);
  });

  test('closing terminates the session', async () => {
    const upstream = fakeUpstream();
    app = await startTestApp({ remote: upstream });
    const gateway = app.get<RemoteGateway>(RemoteGateway);

    await gateway.open(desktop('rs-2'));
    await gateway.close('rs-2');
    expect(gateway.isOpen('rs-2')).toBe(false);
    expect(upstream.sessions.get('rs-2')?.revokeCalls).toBe(1);
    expect(() => gateway.issueTicket('rs-2')).toThrow();
  });

  test('disabled gateway reports not enabled', async () => {
    app = await startTestApp();
    const gateway = app.get<RemoteGateway>(RemoteGateway);
    expect(gateway.enabled).toBe(false);
    expect(gateway.isOpen('rs-3')).toBe(false);
    await expect(gateway.open(desktop('rs-3'))).rejects.toThrow();
    expect(() => gateway.issueTicket('rs-3')).toThrow();
    await expect(gateway.listen(0, '127.0.0.1')).rejects.toThrow();
  });
});
