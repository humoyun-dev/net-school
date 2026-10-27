import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type GatewayStack, startGatewayStack } from './harness/gateway.ts';
import { type MeshCentralInstance, startMeshCentral } from './harness/meshcentral.ts';

let mc: MeshCentralInstance;
let stack: GatewayStack;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

beforeAll(async () => {
  mc = await startMeshCentral();
  stack = await startGatewayStack(mc);
  // TLS tekshiruvi yoqiq: faqat gateway sinov sertifikati SPKI pin orqali ishoniladi.
  browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${stack.spki}`] });
  context = await browser.newContext();
  page = await context.newPage();
});

afterAll(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stack?.broker.close('s-browser').catch(() => {});
  await stack?.stop();
  await mc?.stop();
});

describe('upstream viewer in a real browser', () => {
  test('upstream viewer loads through the gateway in a real browser', async () => {
    const tab = page;
    const jar = context;
    if (!tab || !jar) throw new Error('browser not started');
    const device = await stack.device('pc-01');
    const { ticket } = await stack.broker.open({ sessionId: 's-browser', actorId: 'u-1', device, mode: 'view' });

    const entry = await tab.goto(`${stack.gatewayOrigin}/rs/redeem?ticket=${encodeURIComponent(ticket)}`);
    // Redeem 303 bilan entry sahifaga yo'naltiradi; sahifaning o'zi keyin URL'ni tozalaydi (history.replaceState).
    const entryUrl = new URL(entry?.url() ?? '');
    expect(entryUrl.origin).toBe(stack.gatewayOrigin);
    expect(entryUrl.pathname).toBe('/');
    expect(entryUrl.searchParams.get('viewmode')).toBe('11');
    expect(entry?.request().redirectedFrom()?.url()).toContain('/rs/redeem');
    expect(entry?.status()).toBe(200);
    expect(entry?.headers()['x-frame-options']?.toLowerCase()).toBe('sameorigin');

    try {
      await expect.poll(() => tab.getByText('pc-01').count(), { timeout: 30_000 }).toBeGreaterThan(0);
    } finally {
      const rejected = stack.events.filter((e) => e.type === 'route_denied' || e.type === 'frame_dropped');
      console.log(`gateway rejected events (${rejected.length}):\n${JSON.stringify(rejected, null, 2)}`);
    }

    const cookies = await jar.cookies();
    expect(cookies.map((c) => c.name)).toEqual(['__Host-ns_rs']);
    expect(cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });

    const handles = await tab.evaluate(() => [
      (globalThis as unknown as { authCookie: string }).authCookie,
      (globalThis as unknown as { authRelayCookie: string }).authRelayCookie,
    ]);
    expect(handles).toHaveLength(2);
    for (const handle of handles) expect(handle.startsWith('nsh_')).toBe(true);
  });
});
