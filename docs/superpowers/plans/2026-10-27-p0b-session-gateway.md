# P0b — Remote session broker va gateway PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bir martalik ticket → HttpOnly gateway cookie → MeshCentral upstream viewer'ini faqat ruxsatli yo'llar va filtrlangan WS kadrlar orqali proksi qiluvchi, revoke'da faol ulanishlarni uzuvchi gateway; spec §5.2 "Majburiy PoC" bandlari real pin qilingan MeshCentral'ga qarshi test sifatida.

**Architecture:** `packages/meshcentral-adapter/src/desktop/` MeshCentral'ga xos hamma narsani biladi: principal'ning server tomonidagi login'i (cookie jar gateway'da qoladi), yo'l allowlist'i, `control.ashx`/`meshrelay.ashx` kadr filtrlari va brauzerga boradigan upstream credential'larni (`authCookie`, `authRelayCookie`) gateway handle'lariga almashtirish. `packages/session-gateway` MeshCentral'ni bilmaydi: ticket, cookie, sessiya reestri, HTTP/WS proksi va revoke; upstream'ga `ViewerUpstream` strukturaviy interfeysi orqali murojaat qiladi. Kompozitsiya (adapter + gateway) contract testlarda va keyin P1d'da `apps/api` ichida.

**Tech Stack:** Node 24, TypeScript 5.9 (strict, NodeNext), `node:https` + `ws` 8, vitest 5, `playwright` (faqat contract test, chromium), Biome 2.

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md) (§5.1, §5.2, §10, §15 "Release uchun majburiy tekshiruvlar" — Access qatori). Yo'l xaritasi: [2026-10-27-netschool-roadmap.md](2026-10-27-netschool-roadmap.md). Kirish: [ADR 0002](../../adr/0002-meshcentral-adapter-protocol.md) (ma'lum cheklovlar va P0b ochiq savollari).

## Upstream faktlar (pin `adce1ec4`, kod o'qib tekshirilgan)

Bu bo'lim rejaning dalili; implementer ularni qayta izlamaydi, contract testlar ularni isbotlaydi.

1. **Login.** `POST /login` (`application/x-www-form-urlencoded`: `action=login&username=..&password=..`, webserver.js:7562) `xid` va `xid.sig` cookie'larini beradi; ular har daqiqada qayta beriladi (7451) — jar `Set-Cookie`'ni kuzatadi. Sessiya IP'ga bog'langan (`cookieIpCheck`, 11184). `x-meshauth` faqat WS'da ishlaydi, HTML sahifada emas.
2. **Brauzerga chiqadigan upstream credential'lar.** Sahifada `var authCookie = '…';`, `var authRelayCookie = '…';`, `var serverPublicNamePort = '…';` (default.handlebars:1664-1669; webserver.js:3378-3379). `authCookie` `meshrelay.ashx?auth=` uchun yetarli va `agentPort`dagi `meshrelay.ashx` ham uni qabul qiladi (webserver.js:8122) → **gateway'ni chetlab bevosita relay**. `control.ashx` `authcookie` javobi (`cookie`, `rcookie`) ularni har 30 daqiqada yangilaydi (meshuser.js:6689; default.handlebars:2674).
3. **Viewer trafiki.** Sahifa `/?gotonode=<nodeid>&viewmode=11&hide=31`; statik: `/scripts/`, `/styles/`, `/images/`, `/sounds/`, `/favicon.ico`, `/manifest.json`, `/logo.png`. WS: `/control.ashx` (session cookie bilan), `/meshrelay.ashx?browser=1&p=2&nodeid=<id>&id=<tunnelid>&auth=<authCookie>`; agentni `control.ashx` kadri `{action:'msg',type:'tunnel',nodeid,value:'*/meshrelay.ashx?p=2&nodeid=<id>&id=<tunnelid>&rauth=<authRelayCookie>',usage:2}` chaqiradi (agent-redir-ws-0.1.1.js:75-77). `tunnelid` = `Math.random().toString(36).substring(2)`.
4. **View-only.** Oddiy relay'da input'ni agent tashlaydi (`agents/meshcore.js:3772`, server bergan `rights` bo'yicha); multiplex'da server (meshdesktopmultiplex.js:640-654, input turlari `1,2,10,12,85,87`). `msg` subbuyruqlari (`pskill`, `serviceStop`, `openUrl`, …) view-only bilan ham agentga yetadi (meshuser.js:286), `tcpport`/`tcpaddr` esa ixtiyoriy TCP tunnel ochadi (meshcore.js:1421, meshrelay.js:945-952, rights `0x08` yetarli).
5. **Revoke.** `deleteuser` faqat `control.ashx` sessiyalarini yopadi (meshuser.js:1389); ochiq relay/desktop ulanishlari **yopilmaydi** (meshrelay.js:175-180). Relay'ning bir tomoni yopilsa ikkinchisi ham yopiladi.
6. **Proksi ortida.** `settings.trustedProxy` X-Forwarded-For'ni ishonchli manbadan qabul qiladi va TLS'ni saqlaydi (webserver.js:7353-7372). `maxInvalidLogin` default `{time:10,count:10}`, `blocking:'iprange'` (/24), `exclude` IP/CIDR qabul qiladi (10892-10971). `X-Frame-Options: sameorigin` default (7401-7443).
7. **Parol talablari.** `adduser` `domain.passwordRequirements`ni siteadmin uchun ham tekshiradi (meshuser.js:6376); `_` nonalpha emas → 43 belgili base64url ~51% holatda `nonalpha≥1`dan yiqiladi.

## Global Constraints

- MeshCentral pin: `adce1ec488dc884ce947ea4e4808e6a520609b17`; `infra/meshcentral/upstream` tahrirlanmaydi.
- Faqat `packages/meshcentral-adapter` MeshCentral yo'llari, `nodeid`, rights, `control.ashx`/`meshrelay.ashx` kadr formatini biladi. `packages/session-gateway` adapterni import qilmaydi.
- **Brauzerga hech qanday MeshCentral credential yetmaydi:** principal paroli, `xid`/`xid.sig`, real `authCookie`/`authRelayCookie`, login token. Upstream `Set-Cookie` brauzerga uzatilmaydi.
- TLS tekshiruvi hech qayerda o'chirilmaydi (testlar va Playwright ham): `rejectUnauthorized:false`, `ignoreHTTPSErrors`, `--ignore-certificate-errors` taqiqlangan. Playwright faqat test sertifikatining SPKI pin'i bilan (`--ignore-certificate-errors-spki-list=<sha256-base64>`).
- Ticket: 32 bayt tasodifiy (base64url), TTL 30 s, bir marta; serverda faqat SHA-256 hash saqlanadi; sarflash atomik (spec §5.2-5, §10).
- Gateway cookie: nomi `__Host-ns_rs`, qiymati 32 bayt tasodifiy, `HttpOnly; Secure; SameSite=Strict; Path=/`, `Max-Age` yo'q (sessiya muddati serverda).
- Gateway brauzerdan kelgan `cookie` (o'zinikidan tashqari), `authorization`, `x-meshauth`, `x-forwarded-*`, `x-real-ip`, `cf-connecting-ip`, `forwarded` headerlarini upstream'ga uzatmaydi; `X-Forwarded-For`ni o'zi brauzer socket IP'si bilan qo'yadi.
- Sessiya principal'i P0a'dagidek: view `0xC00F08`, control `0xC00E08`, siteadmin `0x1440`. Clipboard, terminal, fayllar, WebRTC, TCP/UDP tunnel P0b'da **yopiq**.
- Kod identifikatorlari ingliz tilida; docs o'zbekcha.

## Review Focus

1. **Bitta brauzerda ikkinchi viewer** (cookie ustiga yoziladi) — eski sessiya yopilishi kerak, so'rovlar hech qachon jim holda boshqa sessiyaga yo'naltirilmaydi. → Task 6 testi `redeeming a second ticket closes the superseded session`.
2. **Bir ticket'ni parallel ikki marta sarflash** — aniq bittasi muvaffaqiyatli. → Task 5 testi `concurrent redeem yields exactly one binding`.
3. **Upstream HTML formati o'zgargan** (`authCookie` qatori yo'q yoki ikki marta) — xom sahifa o'tkazilmaydi, 502. → Task 3 testi `rewriteViewerHtml fails closed when a credential line is missing or duplicated`.
4. **Takroriy query parametrlar** (`p=2&p=1`, ikki `nodeid`) relay URL'da yoki tunnel `value`da — rad. → Task 2 testlari `routeViewerWs rejects duplicated parameters` va `filterControlUp rejects tunnel value with duplicated parameters`.
5. **MeshCentral yetib bo'lmaydigan paytda revoke** — brauzer socketlari baribir yopiladi, sessiya yopilgan deb belgilanadi, principal revoke xatosi qaytariladi (yashirilmaydi). → Task 7 testi `close() closes sockets even when upstream revoke fails`.

---

### Task 0: Branch

- [ ] **Step 1:** P0a PR (#1) hali merge qilinmagan → stacked branch: `git switch p0a-foundation && git switch -c p0b-session-gateway`. PR P0a merge bo'lgach `main`ga rebase qilinadi.

### Task 1: Qattiqlashtirilgan MeshCentral config shabloni va parol generatori

**Files:**
- Create: `infra/meshcentral/config.template.json`, `packages/meshcentral-adapter/src/password.ts`, `packages/meshcentral-adapter/test/password.test.ts`, `packages/meshcentral-adapter/test/config-template.test.ts`
- Modify: `packages/meshcentral-adapter/src/principals.ts` (parol `generateMeshPassword()` dan), `tests/contracts/harness/meshcentral.ts` (shablonni asos qiladi; admin paroli ham generatordan), `infra/meshcentral/README.md`
- Test: `tests/contracts/adapter.test.ts` (yangi test)

**Interfaces:**
- Produces: `generateMeshPassword(): string` (`@netschool/meshcentral-adapter` eksporti); `startMeshCentral()` endi shablon sozlamalari bilan ishga tushadi (imzo o'zgarmaydi).

- [ ] **Step 1: Failing testlar.** `password.test.ts`:

```typescript
test('generated password satisfies strict MeshCentral requirements', () => {
  for (let i = 0; i < 2_000; i++) {
    const p = generateMeshPassword();
    expect(p.length).toBeGreaterThanOrEqual(16);
    expect(p.length).toBeLessThanOrEqual(64);
    expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/\W/);
  }
});
test('generated passwords are unique', () => {
  expect(new Set(Array.from({ length: 1_000 }, generateMeshPassword)).size).toBe(1_000);
});
```

`config-template.test.ts` (`infra/meshcentral/config.template.json` ni o'qiydi):

```typescript
test('template keeps security-critical settings', () => {
  expect(s.trustedProxy).toBe('127.0.0.1');
  expect(s.desktopMultiplex).toBe(false);
  expect(s.webRTC).toBe(false);
  expect(s.allowLoginToken).toBe(false);
  expect(s.allowFraming).toBe(false);
  expect(s.cookieIpCheck).toBe('strict');
  expect(s.maxInvalidLogin).toEqual({ time: 10, count: 10, coolofftime: 10, blocking: 'ip', exclude: '127.0.0.1,::1' });
});
test('default domain grants nothing to new accounts', () => {
  expect(d.newAccounts).toBe(false);
  expect(d).not.toHaveProperty('newAccountsUserGroups');
  expect(d).not.toHaveProperty('newAccountsRights');
  expect(d.passwordRequirements).toEqual({ min: 16, max: 128, upper: 1, lower: 1, numeric: 1, nonalpha: 1, loginTokens: false });
});
```

- [ ] **Step 2:** `pnpm test -- password config-template` → FAIL (modul/fayl yo'q).
- [ ] **Step 3:** `generateMeshPassword()` = `randomBytes(32).toString('base64url') + '-Aa1'` (256 bit entropiya + har sinfdan kafolatlangan belgi). Shablon: `{ "settings": {…yuqoridagi qiymatlar}, "domains": { "": { "newAccounts": false, "passwordRequirements": {…} } } }`. `principals.ts` generatordan foydalanadi.
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5: Harness.** `startMeshCentral()` shablonni o'qiydi va faqat `settings.{cert, port, redirPort, exactPorts, selfUpdate:false, lanOnly:true, autoBackup:false, filesPath}`ni ustiga yozadi; admin paroli `generateMeshPassword()`. Yangi contract test `adapter.test.ts`:

```typescript
test('principal is created under strict password requirements', async () => {
  const principal = await new MeshCentralPrincipals(admin).create(await deviceNamed('pc-01'), 'view');
  await expect(client({ username: principal.username, password: principal.password }).connect()).resolves.toBeUndefined();
});
```

- [ ] **Step 6:** `pnpm test:contract` → barcha 12 test PASS (P0a'ning 11 tasi shablon ostida ham o'tadi). Agar biror shablon sozlamasi P0a testini buzsa — sozlamani yumshatmang, sababini topib ledger'ga ruling yozing.
- [ ] **Step 7:** README'ga shablon va har sozlama sababi (Upstream faktlar 6–7). Commit `feat(meshcentral): hardened config template and policy-compliant principal passwords`.

### Task 2: Viewer policy — yo'llar va control.ashx kadrlari

**Files:**
- Create: `packages/meshcentral-adapter/src/desktop/credential-handles.ts`, `packages/meshcentral-adapter/src/desktop/viewer-policy.ts`
- Test: `packages/meshcentral-adapter/test/desktop/credential-handles.test.ts`, `packages/meshcentral-adapter/test/desktop/viewer-policy.test.ts`

**Interfaces:**
- Creates (domain): `packages/domain/src/remote-sessions.ts` — `export type RemoteMode = 'view' | 'control'`, `index.ts`dan eksport. Task 4 shu faylga `AuthorizedDesktopRequest`ni qo'shadi.
- Produces:

```typescript
export type CredentialKind = 'auth' | 'relay';
export class CredentialHandles {
  remember(kind: CredentialKind, real: string): string; // 'nsh_' + randomBytes(24).base64url; har tur uchun oxirgi 2 juftlik saqlanadi
  resolve(kind: CredentialKind, handle: string): string | undefined;
  reals(): readonly string[];                           // hozir ma'lum barcha real qiymatlar
}
export type RouteVerdict = { ok: true; upstreamPath: string } | { ok: false; reason: string };
export type FrameVerdict = { ok: true; data: string | Buffer } | { ok: false; reason: string };
export interface ViewerContext { nodeId: string; mode: RemoteMode; handles: CredentialHandles }
export function viewerEntryPath(nodeId: string): string; // '/?gotonode=' + encodeURIComponent(nodeId) + '&viewmode=11&hide=31'
export function routeViewerHttp(method: string, url: URL, ctx: ViewerContext): RouteVerdict;
export function routeViewerWs(url: URL, ctx: ViewerContext): RouteVerdict;
export function filterControlUp(text: string, ctx: ViewerContext): FrameVerdict;
export function filterControlDown(text: string, ctx: ViewerContext): FrameVerdict;
```

Qoidalar (aniq qiymatlar):
- **HTTP:** faqat `GET`/`HEAD`. Yo'l normalizatsiyasi: `..`, `//`, `\`, `%2e`, `%2f`, `%5c` (katta-kichik harf farqsiz) bo'lsa rad. `/` — query kalitlari aynan `{gotonode, viewmode, hide}`, har biri bir marta, `gotonode === ctx.nodeId`, `viewmode === '11'`, `hide` `^\d{1,4}$`. Prefikslar `/scripts/`, `/styles/`, `/images/`, `/sounds/` va aniq `/favicon.ico`, `/manifest.json`, `/logo.png` — query'siz yoki `?<raqam/hex>` cache-buster bilan. Qolgan hamma narsa rad.
- **WS:** `/control.ashx` — query'siz. `/meshrelay.ashx` — kalitlar aynan `{browser, p, nodeid, id, auth}`, har biri bir marta; `browser='1'`, `p='2'`, `nodeid === ctx.nodeId`, `id` `^[0-9a-z]{1,16}$`, `auth` = `handles.resolve('auth', …)` topilishi shart → `upstreamPath`da real qiymat bilan. `tcpport`/`udpport`/boshqa kalit bo'lsa rad.
- **control.ashx up (brauzer → server):** JSON obyekt bo'lmasa rad. Ruxsatli action'lar va kalit to'plamlari (`responseid` ixtiyoriy):
  - `{action}`: `ping`, `pong`, `authcookie`, `usergroups`, `meshes`, `nodes`, `loginTokens`, `files`;
  - `{action, nodeid}` (`nodeid === ctx.nodeId`): `powertimeline`, `lastconnect`, `getsysinfo`, `getnetworkinfo`, `deviceShares`;
  - `{action:'getNotes', id}` (`id === ctx.nodeId`);
  - `msg`: kalitlar aynan `{action, type, nodeid, value, usage}`, `type === 'tunnel'`, `nodeid === ctx.nodeId`, `usage === 2`, `value` `*/meshrelay.ashx?` + aynan `{p:'2', nodeid: ctx.nodeId, id: ^[0-9a-z]{1,16}$, rauth: <handle>}` (har biri bir marta) → `rauth` real `relay` qiymatga almashtirilib qayta seriyalanadi.
  - Boshqa hamma narsa rad (`reason` = `action:<nom>` yoki `msg:<type>`).
- **control.ashx down (server → brauzer):** `action === 'authcookie'` bo'lsa `cookie`/`rcookie` `remember()` bilan handle'ga almashtiriladi. Boshqa kadr matnida `handles.reals()`dan birortasi uchrasa → rad (`reason: 'credential_leak'`).

- [ ] **Step 1: Failing testlar** (`viewer-policy.test.ts`, `NODE = 'node//abc'`, `OTHER = 'node//xyz'`):
  - `routeViewerHttp allows the entry page for the session node only` — `viewerEntryPath(NODE)` ok; `gotonode=OTHER` rad; qo'shimcha `&key=1` rad; `POST /` rad.
  - `routeViewerHttp allows static prefixes and rejects traversal` — `/scripts/x.js` ok; `/scripts/../meshcentral.db`, `/scripts/%2e%2e/x`, `//x`, `/devicefile.ashx`, `/logout`, `/webrelay/` rad.
  - `routeViewerWs maps auth handle to the real cookie` — `upstreamPath` real qiymatni o'z ichiga oladi, handle'ni emas.
  - `routeViewerWs rejects foreign node, tcpport, unknown handle` va `routeViewerWs rejects duplicated parameters` (`p=2&p=1`; ikki `nodeid`).
  - `filterControlUp allows the viewer startup actions` (yuqoridagi ro'yxat).
  - `filterControlUp rejects every non-tunnel msg` — `pskill`, `serviceStop`, `openUrl`, `setclip`, `getclip`, `console`, `localapp` — har biri `{ok:false}`.
  - `filterControlUp rejects actions outside the allowlist` — `getcookie`, `createLoginToken`, `adduser`, `removedevices`, `getsysinfo` with `OTHER`, `nodes` with extra key `meshid`.
  - `filterControlUp rewrites rauth in a valid tunnel request` — natijada real `relay` qiymat, handle yo'q.
  - `filterControlUp rejects tunnel value with duplicated parameters`, `… with tcpport`, `… with p=1`, `… with foreign nodeid`.
  - `filterControlDown swaps refreshed cookies for handles` va `filterControlDown drops frames carrying a real credential`.
  - `credential-handles.test.ts`: `remember returns distinct nsh_ handles`, `resolve keeps the previous pair after one refresh and forgets after two`.
- [ ] **Step 2:** `pnpm test -- desktop` → FAIL.
- [ ] **Step 3:** Implement. Query tahlili `URLSearchParams`dan; takror kalit `getAll(k).length !== 1` bilan aniqlanadi. JSON qayta seriyalash faqat `msg/tunnel` uchun; qolgan ruxsatli kadrlar asl matn bilan o'tadi.
- [ ] **Step 4:** `pnpm test` → PASS; `pnpm lint && pnpm typecheck` → 0.
- [ ] **Step 5:** Commit `feat(meshcentral-adapter): viewer route allowlist and control.ashx frame filter`.

### Task 3: Viewer policy — relay kadrlari va HTML credential almashtirish

**Files:**
- Modify: `packages/meshcentral-adapter/src/desktop/viewer-policy.ts`
- Test: `packages/meshcentral-adapter/test/desktop/viewer-policy.test.ts`, fixture `packages/meshcentral-adapter/test/fixtures/viewer-page.html` (real sahifadan olingan, faqat uchta `var` qatori va atrofidagi bir necha qator; credential qiymatlari soxta)

**Interfaces:**
- Produces:

```typescript
export const VIEW_ONLY_INPUT_COMMANDS: ReadonlySet<number>; // {1, 2, 10, 12, 85, 87}
export function filterRelayUp(data: string | Buffer, isBinary: boolean, mode: RemoteMode): FrameVerdict;
export function rewriteViewerHtml(html: string, ctx: ViewerContext, publicHost: string): string; // xato → AdapterError('invalid_upstream_message')
```

Qoidalar:
- **Relay up, matn kadr:** aynan `'2'` (protokol tanlash); JSON `{type:'options', …}`; JSON `ctrlChannel === '102938'` va `type ∈ {'lock','autolock'}` — faqat `control` rejimda. Boshqa hamma narsa (jumladan WebRTC `offer`/`answer`/`webrtc*`) rad.
- **Relay up, binar kadr:** `view` rejimda: uzunlik < 4 yoki `readUInt16BE(2) !== length` → rad; `readUInt16BE(0) ∈ VIEW_ONLY_INPUT_COMMANDS` → rad; qolgani o'tadi. `control` rejimda binar kadr o'tadi.
- **HTML:** uchta regex — `/var authCookie = '([^']*)';/`, `/var authRelayCookie = '([^']*)';/`, `/var serverPublicNamePort = '([^']*)';/` — har biri aynan bir marta mos kelishi va qiymat bo'sh bo'lmasligi shart. Birinchi ikkisi `remember()` handle'lari bilan, uchinchisi `publicHost` (gateway `host:port`) bilan almashtiriladi. So'ng natijada `handles.reals()`dan birortasi qolsa → xato.

- [ ] **Step 1: Failing testlar:**
  - `filterRelayUp drops every view-only input command` — har bir `1,2,10,12,85,87` turi uchun to'g'ri uzunlikli kadr `view`da rad, `control`da o'tadi.
  - `filterRelayUp passes non-input desktop commands in view mode` — masalan tur `6` (refresh) va `5` (settings).
  - `filterRelayUp drops malformed binary frames in view mode` — uzunlik 3; e'lon qilingan o'lcham ≠ haqiqiy.
  - `filterRelayUp drops WebRTC negotiation in both modes` — `{"type":"offer","sdp":"x"}`, `{"ctrlChannel":"102938","type":"webrtc0"}`.
  - `filterRelayUp allows lock only for control`.
  - `rewriteViewerHtml replaces credentials and public host` — natijada fixture'dagi real qiymatlar yo'q, handle'lar `resolve()` bilan topiladi, `serverPublicNamePort` = `publicHost`.
  - `rewriteViewerHtml fails closed when a credential line is missing or duplicated` — har uch qator uchun yo'q / ikki marta / bo'sh qiymat → `AdapterError` `invalid_upstream_message`.
  - `rewriteViewerHtml fails closed when a credential appears elsewhere in the page` — real `authCookie` qiymati sahifaning boshqa joyida ham bor → xato.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck` → PASS/0.
- [ ] **Step 5:** Commit `feat(meshcentral-adapter): relay frame filter and viewer credential substitution`.

### Task 4: Principal login va `MeshCentralViewerUpstream`

**Files:**
- Create: `packages/meshcentral-adapter/src/desktop/cookie-jar.ts`, `packages/meshcentral-adapter/src/desktop/upstream-login.ts`, `packages/meshcentral-adapter/src/desktop/viewer-upstream.ts`
- Modify: `packages/meshcentral-adapter/src/index.ts` (eksportlar)
- Test: `packages/meshcentral-adapter/test/desktop/cookie-jar.test.ts`, `tests/contracts/viewer-upstream.test.ts`

**Interfaces:**
- Consumes: `MeshCentralPrincipals` (P0a), Task 2–3 policy, `RemoteMode` (Task 2).
- Adds (domain, `packages/domain/src/remote-sessions.ts`; Task 5 ham shuni ishlatadi):

```typescript
export interface AuthorizedDesktopRequest { sessionId: string; actorId: string; device: UpstreamDeviceRef; mode: RemoteMode }
```

- Produces:

```typescript
export class CookieJar { absorb(setCookie: readonly string[]): void; header(): string; has(name: string): boolean }
export interface UpstreamEndpoint { origin: string; ca: string | Buffer; servername?: string } // origin: 'https://localhost:<port>'
export function loginPrincipal(ep: UpstreamEndpoint, creds: { username: string; password: string }, clientIp: string): Promise<CookieJar>;
export interface MeshCentralViewerUpstreamOptions { admin: MeshRequester; endpoint: UpstreamEndpoint; publicHost: string }
export class MeshCentralViewerUpstream { constructor(opts: MeshCentralViewerUpstreamOptions); open(req: AuthorizedDesktopRequest): Promise<MeshCentralViewerSession> }
export class MeshCentralViewerSession {
  readonly entryPath: string;
  attach(clientIp: string): Promise<void>;   // birinchi chaqiruvda login; keyingilarida clientIp boshqa bo'lsa AdapterError('scope_denied')
  routeHttp(method: string, url: URL): RouteVerdict;
  routeWs(url: URL): RouteVerdict;
  requestHeaders(): Record<string, string>;  // { cookie: jar.header(), 'x-forwarded-for': clientIp }
  absorbSetCookie(values: readonly string[]): void;
  rewriteHtml(url: URL, html: string): string; // faqat url.pathname === '/' uchun almashtiradi, boshqasida o'zgarishsiz
  filterFrame(channel: 'control' | 'relay', direction: 'up' | 'down', data: string | Buffer, isBinary: boolean): FrameVerdict; // relay down → o'zgarishsiz o'tadi
  revoke(): Promise<void>;                   // principal deleteuser; ikkinchi chaqiruv no-op
}
```

- `loginPrincipal`: `POST /login` (body `action=login&username&password`, header `x-forwarded-for: clientIp`, redirect kuzatilmaydi) → jar; so'ng `GET /` jar bilan — javobda bo'sh bo'lmagan `var authCookie = '` bo'lmasa `AdapterError('upstream_auth_failed')`. Faqat `https.request` + berilgan `ca`/`servername`.

- [ ] **Step 1: Failing unit test** `cookie-jar.test.ts`: `absorb keeps latest value per name`, `absorb ignores attributes and expired cookies (Max-Age=0)`, `header joins name=value pairs`.
- [ ] **Step 2:** FAIL → implement `CookieJar` → PASS.
- [ ] **Step 3: Failing contract testlar** `tests/contracts/viewer-upstream.test.ts` (real MeshCentral, `pc-01`/`pc-02` lokal qurilmalar, `publicHost: 'gw.test:9443'`):
  - `login gives a session jar with xid and xid.sig`.
  - `entry page through the session has no upstream credential` — `GET entryPath` jar bilan → `rewriteHtml` natijasida real `authCookie` yo'q, `gw.test:9443` bor.
  - `real authCookie opens meshrelay directly but its handle does not` — real cookie bilan bevosita `meshrelay.ashx?browser=1&p=2&nodeid=<pc-01>&id=abc&auth=<real>` upgrade muvaffaqiyatli va socket 1 s davomida ochiq qoladi (agent yo'q, relay sherik kutadi — ijobiy nazorat: bypass xavfi real); handle bilan esa ulanish 2 s ichida yopiladi yoki upgrade rad etiladi.
  - `attach from a different client IP is denied`.
  - `revoke deletes the principal and its control sessions` — `control.ashx` (jar bilan) ochiq; `revoke()` → socket yopiladi; qayta login → `upstream_auth_failed`.
- [ ] **Step 4:** FAIL → implement `upstream-login.ts`, `viewer-upstream.ts` → `pnpm test:contract` PASS.
- [ ] **Step 5:** Commit `feat(meshcentral-adapter): server-side principal login and viewer upstream session`.

### Task 5: `session-gateway` — ticket, sessiya reestri, broker

**Files:**
- Create: `packages/test-support/{package.json,tsconfig.json,src/index.ts}` (`makeCert`, `tick`, `until`ni `packages/meshcentral-adapter/test/support/fake-mesh-server.ts`dan ko'chiring; ikki importerni yangilang)
- Create: `packages/session-gateway/{package.json,tsconfig.json,src/index.ts,src/types.ts,src/tickets.ts,src/registry.ts,src/broker.ts}`
- Modify: `packages/domain/src/index.ts` (Task 4 tiplari eksport qilingan bo'lsin), `vitest.config.ts` (o'zgarish kerak emas: `packages/*/test`)
- Test: `packages/session-gateway/test/{tickets,registry,broker}.test.ts`, `packages/session-gateway/test/support/fake-upstream.ts`

**Interfaces:**
- Produces (`@netschool/session-gateway`):

```typescript
export type RouteVerdict = { ok: true; upstreamPath: string } | { ok: false; reason: string };
export type FrameVerdict = { ok: true; data: string | Buffer } | { ok: false; reason: string };
export interface UpstreamViewerSession { /* Task 4 MeshCentralViewerSession bilan aynan bir xil a'zolar */ }
export interface ViewerUpstream { open(req: AuthorizedDesktopRequest): Promise<UpstreamViewerSession> }
export type GatewayEvent =
  | { type: 'ticket_rejected'; reason: 'unknown' | 'expired' }
  | { type: 'route_denied'; sessionId: string; kind: 'http' | 'ws'; path: string; reason: string }
  | { type: 'frame_dropped'; sessionId: string; channel: 'control' | 'relay'; direction: 'up' | 'down'; reason: string }
  | { type: 'upstream_error'; sessionId: string; message: string }
  | { type: 'session_closed'; sessionId: string; reason: 'revoked' | 'superseded' };

export class TicketStore {
  constructor(opts?: { ttlMs?: number; now?: () => number }); // ttl default 30_000
  issue(sessionId: string): { ticket: string; expiresAt: number };
  redeem(ticket: string): { sessionId: string } | { error: 'unknown' | 'expired' };
}
export interface GatewaySession { id: string; upstream: UpstreamViewerSession; sockets: Set<{ close(code?: number): void }>; closed: boolean }
export class SessionRegistry {
  add(id: string, upstream: UpstreamViewerSession): GatewaySession;
  bindCookie(sessionId: string): string;                // yangi 32 bayt cookie qiymati; faqat SHA-256 saqlanadi
  byCookie(value: string | undefined): GatewaySession | undefined; // yopilgan sessiya → undefined
  get(id: string): GatewaySession | undefined;
  close(id: string, reason: 'revoked' | 'superseded'): Promise<void>; // avval socketlar (1008), keyin upstream.revoke(); revoke xatosi qayta otiladi, sessiya baribir closed
}
export class RemoteSessionBroker {
  constructor(opts: { upstream: ViewerUpstream; tickets: TicketStore; registry: SessionRegistry; onEvent?: (e: GatewayEvent) => void });
  open(req: AuthorizedDesktopRequest): Promise<{ sessionId: string; ticket: string; expiresAt: number }>;
  close(sessionId: string): Promise<void>;
}
```

- [ ] **Step 1: Failing testlar:**
  - `tickets.test.ts`: `ticket is single use` (ikkinchi redeem → `unknown`); `ticket expires after 30 s` (soxta `now`, 30_001 ms → `expired`); `concurrent redeem yields exactly one binding` (`Promise.all` ikki `redeem` → bittasi `sessionId`); `store keeps only hashes` (ichki xaritada xom ticket matni yo'q — `JSON.stringify([...])` tekshiruvi); `issued tickets are 43-char base64url and unique`.
  - `registry.test.ts`: `byCookie returns the bound session`; `unknown or closed cookie returns undefined`; `close closes sockets with 1008 before revoking upstream` (chaqiruv tartibi); `close() closes sockets even when upstream revoke fails` (revoke reject → `close` reject, lekin socketlar yopilgan va `closed === true`); `close is idempotent`.
  - `broker.test.ts`: `open creates upstream session then issues ticket`; `open does not issue a ticket when upstream open fails`; `close delegates to registry with reason revoked`.
- [ ] **Step 2:** FAIL → **Step 3:** implement. **Step 4:** `pnpm test`/`lint`/`typecheck` → PASS/0.
- [ ] **Step 5:** Commit `feat(session-gateway): single-use tickets, session registry and broker`.

### Task 6: Gateway HTTP — redeem, cookie, proksi

**Files:**
- Create: `packages/session-gateway/src/server.ts`, `packages/session-gateway/src/headers.ts`
- Test: `packages/session-gateway/test/server-http.test.ts` (soxta HTTPS upstream + `fake-upstream.ts`)

**Interfaces:**
- Produces:

```typescript
export interface GatewayOptions {
  tls: { key: string; cert: string };
  upstream: { origin: string; ca: string | Buffer; servername?: string };
  broker: RemoteSessionBroker; tickets: TicketStore; registry: SessionRegistry;
  maxHtmlBytes?: number;                 // default 5 MiB
  onEvent?: (e: GatewayEvent) => void;
}
export function createGateway(opts: GatewayOptions): { server: import('node:https').Server; listen(port: number, host: string): Promise<number>; close(): Promise<void> };
export const GATEWAY_COOKIE = '__Host-ns_rs';
export function sanitizeRequestHeaders(h: import('node:http').IncomingHttpHeaders): Record<string, string>; // headers.ts
```

Xatti-harakat:
- `GET /rs/redeem?ticket=<t>` → `redeem`; xato → 403 + `ticket_rejected`. Muvaffaqiyat → `session.upstream.attach(clientIp)` (xato → 502 + `upstream_error`, sessiya yopiladi). Brauzerda boshqa ochiq sessiya cookie'si bo'lsa → o'sha sessiya `close(…,'superseded')`. Javob: 303 `Location: <entryPath>`, `Set-Cookie: __Host-ns_rs=<v>; HttpOnly; Secure; SameSite=Strict; Path=/`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- Boshqa so'rov: cookie → sessiya yo'q bo'lsa 401. `routeHttp` rad → 403 + `route_denied`. Aks holda upstream'ga `https.request` (`ca`, `servername`), headerlar = `sanitizeRequestHeaders(req.headers)` + `session.upstream.requestHeaders()`. Javobda upstream `set-cookie` olib tashlanadi va `absorbSetCookie`ga beriladi. `content-type` `text/html` bo'lsa tana yig'iladi (`maxHtmlBytes` dan oshsa 502), `rewriteHtml` (xato → 502 + `upstream_error`), `content-length` qayta hisoblanadi. Boshqa javoblar oqim bilan.
- `sanitizeRequestHeaders`: `host`, `cookie`, `authorization`, `x-meshauth`, `forwarded`, `x-forwarded-*`, `x-real-ip`, `cf-connecting-ip`, `connection`, `upgrade` va hop-by-hop headerlar olib tashlanadi.

- [ ] **Step 1: Failing testlar** (`server-http.test.ts`):
  - `redeem sets a host-only HttpOnly Secure SameSite=Strict cookie and redirects to the entry path`.
  - `replayed ticket is rejected with 403`; `expired ticket is rejected with 403`.
  - `request without a session cookie gets 401`.
  - `denied route gets 403 and emits route_denied`.
  - `upstream Set-Cookie never reaches the browser and is absorbed into the session`.
  - `browser-supplied credential and forwarding headers are not forwarded` (soxta upstream olgan headerlarni tekshiradi: `x-meshauth`, `authorization`, brauzer `cookie`, soxta `x-forwarded-for` yo'q; `x-forwarded-for` = haqiqiy socket IP).
  - `html responses are rewritten; rewrite failure returns 502`.
  - `oversized html returns 502`.
  - `redeeming a second ticket closes the superseded session` (birinchi sessiya `closed`, `session_closed` `superseded`, eski cookie → 401).
  - `failed attach returns 502 and closes the session`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** `pnpm test`/`lint`/`typecheck` → PASS/0.
- [ ] **Step 5:** Commit `feat(session-gateway): ticket redemption, session cookie and filtered HTTP proxy`.

### Task 7: Gateway WS — upgrade, kadr filtri, revoke'da uzish

**Files:**
- Modify: `packages/session-gateway/src/server.ts`
- Create: `packages/session-gateway/src/ws-proxy.ts`
- Test: `packages/session-gateway/test/server-ws.test.ts`

**Interfaces:**
- Consumes: Task 5–6.
- Xatti-harakat: `upgrade` hodisasida cookie → sessiya (yo'q → 401 va socket yopiladi); `Origin` aynan gateway origin'i bo'lmasa → 403; `routeWs` rad → 403 + `route_denied`. Kanal: yo'l `/control.ashx` → `'control'`, `/meshrelay.ashx` → `'relay'`. Upstream WS: `ws` klient, `ca`/`servername`, headerlar `sanitizeRequestHeaders` + `requestHeaders()`, `origin` = `upstream.origin`, `maxPayload` 4 MiB. Brauzer WS `noServer` + `handleUpgrade`, `maxPayload` 4 MiB. Har kadr `filterFrame(channel, dir, data, isBinary)`; rad → kadr tashlanadi + `frame_dropped` (ulanish uzilmaydi). Ikkala socket `session.sockets`ga qo'shiladi; bir tomon yopilsa ikkinchisi ham. Upstream ochilguncha kelgan brauzer kadrlari navbatda (1 MiB limit, oshsa 1009 bilan yopiladi).

- [ ] **Step 1: Failing testlar:**
  - `upgrade without session cookie is rejected`; `upgrade with foreign Origin is rejected`; `denied ws route is rejected`.
  - `allowed frames pass both ways`; `dropped frame does not close the connection and emits frame_dropped`.
  - `registry close() closes both browser and upstream sockets within 1 s`.
  - `close() closes sockets even when upstream revoke fails` (Review Focus 5 — WS darajasida).
  - `upstream close closes the browser socket`.
  - `frames sent before upstream is open are delivered in order`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS/0.
- [ ] **Step 5:** Commit `feat(session-gateway): filtered WebSocket proxy with revoke-time disconnect`.

### Task 8: Contract suite — §5.2 Majburiy PoC (protokol darajasi)

**Files:**
- Create: `tests/contracts/gateway.test.ts`, `tests/contracts/harness/gateway.ts`

**Interfaces:**
- `startGatewayStack(mc: MeshCentralInstance): Promise<{ gatewayOrigin: string; ca: string; broker: RemoteSessionBroker; registry: SessionRegistry; events: GatewayEvent[]; admin: MeshControlClient; device(name: string): Promise<UpstreamDeviceRef>; stop(): Promise<void> }>` — gateway `makeCert('localhost')` bilan `127.0.0.1:0`da, `publicHost` = `localhost:<port>`. Brauzer o'rnida `node:https` (`ca` bilan) va `ws` klient; cookie qo'lda olib yuriladi.

- [ ] **Step 1: Failing testlar** (har biri sessiya `pc-01`, `view` yoki aytilgan rejim):
  - `scoped identity: viewer session lists only the session node` — gateway `control.ashx` orqali `nodes` → faqat `pc-01`.
  - `cookie and websocket routing work end to end` — redeem → entry page 200 → `control.ashx` → `serverinfo` keladi.
  - `no MeshCentral credential reaches the browser` — redeem va entry page javoblarida `set-cookie` faqat `__Host-ns_rs`; HTML'da principal paroli, `xid`, real `authCookie`/`authRelayCookie` yo'q (real qiymatlar testda adapter orqali bevosita olinadi va solishtiriladi).
  - `direct relay bypass with browser-visible values fails` — sahifadagi `authCookie` handle'i bilan MeshCentral'ga **bevosita** `meshrelay.ashx?…&auth=<handle>` va `control.ashx`ga ulanish rad etiladi.
  - `node swap attempts are denied` — `/?gotonode=<pc-02>…` → 403; `meshrelay.ashx?nodeid=<pc-02>` → 403; `control.ashx` orqali `getsysinfo {nodeid:<pc-02>}` → `frame_dropped`, javob yo'q, xuddi shu `pc-01` bilan → javob keladi.
  - `view-only session cannot send agent msg commands` — `msg` `pskill`/`serviceStop`/`openUrl` → `frame_dropped`, upstream'ga yetmaydi.
  - `tcp tunnel requests are denied` — `meshrelay.ashx?nodeid=<pc-01>&tcpport=22&…` → 403; tunnel `value`da `tcpport` → `frame_dropped`.
  - `stale and replayed tickets are rejected` — 30 s'dan keyin (TicketStore soxta `now`) va ikkinchi redeem → 403.
  - `revoke closes active control and relay sockets and the principal can no longer log in` — `control.ashx` + `meshrelay.ashx` (agent yo'q, relay kutish holatida) ochiq → `broker.close()` → ikkala socket ≤ 2 s ichida yopiladi; o'sha cookie bilan yangi so'rov 401; principal `loginPrincipal` → `upstream_auth_failed`.
  - IP bog'lanishi bu yerda alohida test qilinmaydi: contract testda brauzer va gateway bir xil `127.0.0.1`da. Boshqa IP'dan `attach` rad etilishini Task 4 isbotlaydi; `cookieIpCheck: 'strict'` ostida butun oqim ishlashini shu fayldagi qolgan testlar tasdiqlaydi.
- [ ] **Step 2:** FAIL (gateway harness yo'q) → **Step 3:** harness'ni yozing → **Step 4:** `pnpm test:contract` → PASS (P0a + Task 1/4 + shu fayl).
- [ ] **Step 5:** Commit `test(contracts): gateway proves scoped identity, routing, node swap, bypass and revoke`.

### Task 9: Haqiqiy brauzerda viewer (Playwright)

**Files:**
- Create: `tests/contracts/viewer-browser.test.ts`
- Modify: root `package.json` (devDependency `playwright`, aniq versiya pin), `.github/workflows/ci.yml` (contract job: `pnpm exec playwright install --with-deps chromium`), `tests/contracts/harness/gateway.ts` (gateway sertifikatining SPKI sha256-base64 qiymatini qaytaradi)

**Interfaces:**
- Consumes: `startGatewayStack`.

- [ ] **Step 1: Failing test** `upstream viewer loads through the gateway in a real browser`:
  - `chromium.launch({ args: ['--ignore-certificate-errors-spki-list=' + spki] })` — boshqa TLS-bypass opsiyasi yo'q. Bayroq ishlamasa **to'xtang va so'rang**; `ignoreHTTPSErrors`ga o'tilmaydi.
  - `page.goto(gatewayOrigin + '/rs/redeem?ticket=…')` → yakuniy URL `entryPath`; sahifada `pc-01` nomi ko'rinadi (`await expect.poll(() => page.getByText('pc-01').count()).toBeGreaterThan(0)`).
  - Entry page javobida upstream'ning `x-frame-options: sameorigin` headeri saqlangan (begona origin iframe qila olmaydi). Iframe ichiga joylash P1f'da: teacher web gateway bilan bir origin'da xizmat qilinadi, chunki `SameSite=Strict` cookie cross-site iframe'da yuborilmaydi.
  - `context.cookies()` → faqat `__Host-ns_rs` (`httpOnly: true`, `secure: true`, `sameSite: 'Strict'`).
  - `page.evaluate(() => [authCookie, authRelayCookie])` → ikkalasi `nsh_` bilan boshlanadi.
  - Yig'ilgan `events`da `route_denied`/`frame_dropped` ro'yxati assert'dan oldin konsolga chiqariladi; viewer ishlashi uchun zarur yo'l yoki action rad etilgan bo'lsa (sahifa yuklanmasa) — allowlist'ni kengaytirish **ruling** sifatida ledger'ga, sababi bilan; xavfsizlik qoidasini (Global Constraints) buzadigan kengaytirish taqiqlanadi.
- [ ] **Step 2:** FAIL → **Step 3:** kerakli tuzatishlar → **Step 4:** `pnpm test:contract` PASS; CI'da ham.
- [ ] **Step 5:** Commit `test(contracts): upstream viewer works through the gateway in Chromium`.

### Task 10: Hujjatlar va qaror nuqtasi

**Files:**
- Create: `docs/adr/0003-session-gateway.md`
- Modify: `docs/adr/0002-meshcentral-adapter-protocol.md` (P0b ochiq savollariga javoblar va havolalar), `docs/superpowers/plans/2026-10-27-netschool-roadmap.md` (P0b holati), `README.md` (yangi paketlar)

- [ ] **Step 1:** ADR 0003 mazmuni:
  - **Qarorlar:** server tomonidagi login + gateway cookie jar; credential almashtirish (handle'lar); yo'l allowlist; `control.ashx`/relay kadr filtrlari va ularning to'liq ro'yxati; bitta brauzerda bitta viewer (superseded); shablon sozlamalari.
  - **Qaror nuqtasi (roadmap P0b):** gateway qamrab ololmagan endpoint topildimi — Task 8–9 natijasi bilan. Kutilgan javob: P0b uchun fork patch shart emas. Defence-in-depth uchun kelajakdagi fork patch nomzodlari: user o'chirilganda/rights o'zgarganda relay sessiyalarini yopish; `tcpport`/`udpport`ni RELAY huquqisiz rad etish; agent `msg` subbuyruqlarini rights bilan cheklash; WebRTC sozlamasini server tomonida majburlash.
  - **P0c'ga o'tkaziladiganlar (haqiqiy agent talab qiladi):** view-only'da klaviatura/sichqoncha haqiqatan ham qurilmaga yetmasligi (agent + gateway relay filtri birga), WebRTC o'chiqligi, relay text-kadr allowlist'ining to'liqligi, `agentPort`/`portBind` tarmoq ta'siri. Bular P0c runbook'ida majburiy band.
  - **Ma'lum cheklovlar:** gateway restart'ida sessiyalar yo'qoladi, principal'lar yetim qoladi → P1d startup reconciliation; bir brauzerda parallel ikki viewer yo'q (P1f'da path-prefix yoki alohida origin bilan qayta ko'riladi); sessiya muddati/lease P1d.
- [ ] **Step 2:** ADR 0002 "P0b uchun ochiq savollar" bo'limini javoblar bilan almashtiring (1: yo'q, gateway yopadi; 2: server-side login + jar, token emas; 3: `webRTC:false` server tomonida majburiy emas → gateway relay filtri; 4: `trustedProxy` + `maxInvalidLogin` `blocking:'ip'`, `exclude: 127.0.0.1,::1`; 5: `generateMeshPassword`). "Ma'lum cheklovlar"dagi view-only bandiga ADR 0003 havolasi.
- [ ] **Step 3:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:contract` → hammasi 0.
- [ ] **Step 4:** Commit `docs: record session gateway decisions and close P0b open questions`.
