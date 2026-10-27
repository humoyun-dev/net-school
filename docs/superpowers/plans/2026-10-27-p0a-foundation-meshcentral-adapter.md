# P0a — Monorepo poydevori va MeshCentral adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pnpm/TypeScript monorepo, `domain` port va `contracts` schema, hamda real pin qilingan MeshCentral'ga qarshi contract testlardan o'tgan `meshcentral-adapter` (inventory, events, scoped principal grant/revoke).

**Architecture:** `packages/domain` transportdan mustaqil tiplar va `DeviceManagementPort` ni beradi. `packages/meshcentral-adapter` `control.ashx` ga TLS tekshiruvli bitta persistent WebSocket orqali ulanadi (`responseid` correlation, timeout, reconnect + resync) va portni amalga oshiradi. `tests/contracts` submodule'dagi MeshCentral'ni vaqtinchalik datapath bilan ishga tushirib adapterni real serverga qarshi tekshiradi.

**Tech Stack:** Node 24 LTS, pnpm 11 workspaces, TypeScript 5 (strict, NodeNext), vitest, zod, ws, selfsigned (faqat testda), Biome.

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md) (§5.1, §7, §8, §12). Yo'l xaritasi: [2026-10-27-netschool-roadmap.md](2026-10-27-netschool-roadmap.md).

## Global Constraints

- MeshCentral pin: `adce1ec488dc884ce947ea4e4808e6a520609b17`, `infra/meshcentral/upstream` — tahrirlanmaydi.
- Faqat `packages/meshcentral-adapter` MeshCentral `nodeid`, rights bitlari va `control.ashx` formatini biladi; boshqa paketlar ularni import qilmaydi.
- `packages/domain` hech qanday runtime dependency import qilmaydi (`ws`, `zod`, Node `net/tls` ham yo'q).
- `rejectUnauthorized: false` yoki TLS tekshiruvini o'chiruvchi har qanday opsiya taqiqlangan, testlarda ham. Testlar self-signed CA'ni `ca` orqali beradi.
- Har so'rovda unique `responseid` (`crypto.randomUUID()`); har UI amali uchun yangi process/ulanish ochilmaydi.
- MeshCentral DB fayllari o'qilmaydi/yozilmaydi; faqat `control.ashx` protokoli.
- Sessiya principal'iga `EDITMESH|MANAGEUSERS|MANAGECOMPUTERS` (bitlar `1|2|4`) va `AGENTCONSOLE (16)`, `REMOTECOMMAND (0x20000)` hech qachon berilmaydi; `siteadmin: 0`.
- Kod identifikatorlari ingliz tilida; docs o'zbekcha.

## Review Focus

1. **Server qayta ishga tushishi o'rtasidagi so'rov** — pending so'rov abadiy osilib qolmasligi kerak: darhol `upstream_unavailable` bilan rad; reconnectdan keyin `resync` event. → Task 5 testi `rejects pending requests and emits resync after reconnect`.
2. **Bir mesh ichidagi boshqa qurilma** — principal faqat grant qilingan node'ni ko'rishi kerak, qo'shni node'ni emas. → Task 7 testi `principal sees only the granted node`.
3. **Boshqa domain nodeid'i** (`node/otherdomain/...`) — adapter uni o'z site'iga tegishli deb qabul qilmasligi kerak. → Task 4 testi `parseNodeId rejects foreign domain`.
4. **Noma'lum/yangi upstream xabar formati** — parser crash qilmasdan e'tiborsiz qoldiradi, ulanish uzilmaydi. → Task 4 testi `parseDeviceEvent returns null for unknown actions and malformed payloads`.
5. **Juda katta xabar** (`maxMessageBytes` dan katta) — RAM o'smaydi, ulanish yopilib reconnect qilinadi. → Task 5 testi `drops oversized frames and reconnects`.

---

### Task 0: Hozirgi qayta tuzilishni commit qilish

- [ ] **Step 1:** `git status -s` — staged: `.gitignore`, `.gitmodules`, `README.md`, `docs/`, `infra/meshcentral/`. `meshcentral-data/` va `node_modules/` ro'yxatda **bo'lmasligi** kerak.
- [ ] **Step 2:** Commit (shu plan fayllari ham qo'shiladi):

```bash
git add -A && git commit -m "chore: restructure as NetSchool monorepo with pinned MeshCentral submodule"
```

### Task 1: Monorepo toolchain

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `biome.json`, `.nvmrc`, `.github/workflows/ci.yml`
- Create: `packages/domain/{package.json,tsconfig.json,src/index.ts}`, `packages/domain/test/smoke.test.ts`

**Interfaces:**
- Produces: root skriptlar `pnpm test` (unit), `pnpm test:contract`, `pnpm typecheck`, `pnpm lint`; paket nomlari `@netschool/<dir>`; har paket `src/index.ts` → `exports: { ".": "./src/index.ts" }` (build bosqichisiz, vitest/tsc to'g'ridan-to'g'ri TS o'qiydi).

- [ ] **Step 1:** Root `package.json`: `"private": true`, `"packageManager": "pnpm@11.0.9"`, `"engines": { "node": ">=24" }`, `"type": "module"`. Skriptlar: `test` = `vitest run --project unit`, `test:contract` = `vitest run --project contract`, `typecheck` = `pnpm -r exec tsc --noEmit`, `lint` = `biome check .`. Root devDependencies: `typescript`, `vitest`, `@biomejs/biome`, `tsx`, `@types/node`. `.nvmrc` = `24`. `pnpm-workspace.yaml`: `packages: ["packages/*", "apps/*", "tests/*"]`.
- [ ] **Step 2:** `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `module`/`moduleResolution` = `NodeNext`, `target` = `ES2023`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`. `vitest.config.ts` (`test.projects`): `unit` project = `packages/*/test/**/*.test.ts`; `contract` project = `tests/contracts/**/*.test.ts`, `testTimeout: 60_000`, `hookTimeout: 180_000`, `fileParallelism: false`. `biome.json`: `infra/meshcentral/upstream/**` ignor.
- [ ] **Step 3:** Smoke test `packages/domain/test/smoke.test.ts`: `expect(typeof (await import('../src/index.ts'))).toBe('object')`.
- [ ] **Step 4:** `pnpm install && pnpm test && pnpm typecheck && pnpm lint` → hammasi exit 0.
- [ ] **Step 5:** CI `.github/workflows/ci.yml`: `checkout` (`submodules: false`), pnpm, Node 24, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. (Contract job Task 7'da.)
- [ ] **Step 6:** Commit `chore: add pnpm/TypeScript/vitest monorepo toolchain`.

### Task 2: Domain tiplar va capability contract

**Files:**
- Create: `packages/domain/src/devices.ts`, `packages/domain/src/ports/device-management.ts`, `packages/domain/src/index.ts` (re-export)
- Create: `packages/contracts/{package.json,tsconfig.json,src/index.ts,src/capabilities.ts}`, `packages/contracts/test/capabilities.test.ts`
- Delete: `packages/domain/test/smoke.test.ts`

**Interfaces:**
- Produces (`@netschool/domain`):

```typescript
export interface UpstreamDeviceRef { meshInstanceId: string; meshDomainId: string; meshNodeId: string }
export type PowerState = 'on' | 'sleep' | 'off' | 'unknown';
export interface DeviceSnapshot {
  upstream: UpstreamDeviceRef; name: string; hostname: string | null;
  osDescription: string | null; agentOnline: boolean; powerState: PowerState;
}
export type DeviceEvent =
  | { type: 'device.connectivity'; upstream: UpstreamDeviceRef; agentOnline: boolean; powerState: PowerState }
  | { type: 'device.added' | 'device.changed' | 'device.removed'; upstream: UpstreamDeviceRef }
  | { type: 'resync' };
export type Unsubscribe = () => void;
export interface DeviceManagementPort {
  listDevices(siteId: string): Promise<DeviceSnapshot[]>;
  subscribeDeviceEvents(handler: (event: DeviceEvent) => void): Unsubscribe;
  // reconcileEnrollment, openDesktopSession, closeDesktopSession, requestPowerAction — P0b/P1b'da qo'shiladi (spec §5.1).
}
```

- Produces (`@netschool/contracts`): `capabilityReportSchema` (zod), `type CapabilityReport = z.infer<...>`, `capabilityStateSchema = z.enum(['available','requires_permission','requires_setup','unsupported','degraded'])`.

- [ ] **Step 1: Failing test** `packages/contracts/test/capabilities.test.ts`:
  - `parses the spec §7 example` — spec §7 dagi JSON aynan (`protocolVersion: 1`, `os: "linux"`, `architecture: "arm64"`, `desktopSession: "wayland"`, 4 ta capability) → `capabilityReportSchema.parse` muvaffaqiyatli, `result.capabilities['screen.control'].reason === 'adapter_not_certified'`.
  - `rejects boolean capabilities` — `capabilities: { 'screen.view': true }` → `safeParse(...).success === false`.
  - `rejects unknown state` — `state: 'maybe'` → `success === false`.
  - `rejects unsupported protocolVersion` — `protocolVersion: 2` → `success === false`.
- [ ] **Step 2:** `pnpm test` → FAIL (`capabilityReportSchema` yo'q).
- [ ] **Step 3:** Schema: `protocolVersion: z.literal(1)`, `os: z.enum(['windows','macos','linux','chromeos','android','ios','ipados','other'])`, `architecture: z.string().min(1)`, `desktopSession: z.enum(['x11','wayland','windows','macos','none']).nullable()`, `capabilities: z.record(z.string().regex(/^[a-z]+(\.[a-z]+)+$/), z.object({ state: capabilityStateSchema, provider: z.string().optional(), reason: z.string().optional(), enforcement: z.enum(['soft','hard']).optional() }).strict())`. Domain tiplarini yuqoridagicha yozing (logika yo'q).
- [ ] **Step 4:** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(domain,contracts): device port types and capability report schema`.

### Task 3: MeshCentral test harness va real fixture'lar

**Files:**
- Create: `tests/contracts/{package.json,tsconfig.json}`, `tests/contracts/harness/meshcentral.ts`, `tests/contracts/harness/probe.ts`, `tests/contracts/harness.test.ts`
- Create: `packages/meshcentral-adapter/test/fixtures/{nodes.json,event-addnode.json,event-changenode.json,event-removenode.json,auth-failure.md}`
- Modify: root `package.json` — skript `meshcentral:install` = `cd infra/meshcentral/upstream && npm ci --omit=optional --no-audit`

**Interfaces:**
- Produces:

```typescript
export interface MeshCentralInstance {
  url: string;              // wss://localhost:<port>/control.ashx
  ca: string;               // datapath/root-cert-public.crt PEM
  admin: { username: string; password: string };
  restart(): Promise<void>; // bir xil datapath/port bilan to'xtatib qayta ishga tushiradi, tayyorlikni kutadi
  stop(): Promise<void>;    // process kill + datapath o'chirish
}
export function startMeshCentral(): Promise<MeshCentralInstance>;
```

- [ ] **Step 1: Failing test** `tests/contracts/harness.test.ts` → `starts a pinned MeshCentral and serves TLS signed by its own CA`: `startMeshCentral()`, keyin `https.get(url /, { ca })` status `200`; `stop()` dan keyin port yopiq.
- [ ] **Step 2:** `pnpm meshcentral:install && pnpm test:contract` → FAIL.
- [ ] **Step 3:** `startMeshCentral` (`tests/contracts/harness/meshcentral.ts`):
  - `mkdtemp` datapath (scratch, `os.tmpdir()`); bo'sh port `net.createServer().listen(0)` orqali.
  - `config.json`: `{ "settings": { "cert": "localhost", "port": <p>, "redirPort": 0, "exactPorts": true, "selfUpdate": false, "lanOnly": true }, "domains": { "": { "newAccounts": false } } }`.
  - Admin: `node meshcentral.js --datapath <d> --createaccount admin --pass <random 24 char> --email admin@netschool.test`, keyin `--adminaccount admin` (ikkalasi ham process tugashini kutadi).
  - Server: `spawn(process.execPath, ['meshcentral.js','--datapath',d], { cwd: upstream })`; tayyorlik = `https.get` 200 qaytguncha 500 ms polling, 150 s limit; limitda stdout/stderr bilan xato.
  - `ca` = `<d>/root-cert-public.crt`.
- [ ] **Step 4:** `pnpm test:contract` → PASS.
- [ ] **Step 5: Fixture capture** `tests/contracts/harness/probe.ts` (`pnpm tsx tests/contracts/harness/probe.ts`): `ws` bilan `x-meshauth` (`base64(user),base64(pass)`) va `ca` orqali ulanadi; `createmesh` (`meshname: 'probe', meshtype: 3`), `addlocaldevice` (`type: 4`, `devicename: 'pc-01'`, `hostname: 'pc-01.lan'`), `changedevice` (nom o'zgartirish), `removedevices`, so'ng `nodes` — xom javoblarni fixture fayllarga yozadi (meshid/nodeid'lar o'z holida, parollar yo'q). Noto'g'ri parol bilan ulanish natijasini (close code, yuborilgan xabarlar) `auth-failure.md` ga yozadi.
- [ ] **Step 6:** Fixture'larni ko'rib chiqing: `nodes.json` da `nodes[<meshid>][].{_id,name,host,osdesc,conn,pwr}` maydonlari borligini tasdiqlang; farq bo'lsa Task 4 dagi mapping jadvalini shu faktga moslang va bu faylda qayd eting.
- [ ] **Step 7:** Commit `test(contracts): pinned MeshCentral harness and captured protocol fixtures`.

### Task 4: Adapter — sof mapping (nodeid, rights, nodes, events)

**Files:**
- Create: `packages/meshcentral-adapter/{package.json,tsconfig.json}`, `src/node-id.ts`, `src/rights.ts`, `src/map-nodes.ts`, `src/map-events.ts`, `src/errors.ts`
- Test: `packages/meshcentral-adapter/test/{node-id,rights,map-nodes,map-events}.test.ts`

**Interfaces:**
- Consumes: `UpstreamDeviceRef`, `DeviceSnapshot`, `DeviceEvent`, `PowerState` (Task 2); fixture'lar (Task 3).
- Produces:

```typescript
export interface SiteMeshScope { meshInstanceId: string; meshDomainId: string } // '' = default domain
export function parseNodeId(raw: string, scope: SiteMeshScope): UpstreamDeviceRef;   // throws AdapterError('scope_denied')
export function formatNodeId(ref: UpstreamDeviceRef): string;                       // 'node/<domain>/<id>'
export const VIEW_RIGHTS = 0x0F08;    // REMOTECONTROL|REMOTEVIEWONLY|NOTERMINAL|NOFILES|NOAMT = 3848
export const CONTROL_RIGHTS = 0x0E08; // REMOTECONTROL|NOTERMINAL|NOFILES|NOAMT = 3592
export function rightsFor(mode: 'view' | 'control'): number;
export function mapNodesResponse(msg: unknown, scope: SiteMeshScope): DeviceSnapshot[];
export function parseDeviceEvent(msg: unknown, scope: SiteMeshScope): DeviceEvent | null;
export type AdapterErrorCode = 'upstream_unavailable' | 'upstream_timeout' | 'upstream_rejected'
  | 'upstream_auth_failed' | 'upstream_tls_failed' | 'invalid_upstream_message' | 'scope_denied';
export class AdapterError extends Error { constructor(code: AdapterErrorCode, message: string, detail?: unknown); readonly code: AdapterErrorCode }
```

Mapping qoidalari (fixture bilan tasdiqlangan):
- `agentOnline = (conn & 1) === 1`.
- `pwr`: `1 → 'on'`; `2,3,4,5 → 'sleep'`; `6 → 'off'`; boshqasi/yo'q → `'unknown'`.
- `osdesc` → `osDescription`, `host` → `hostname` (yo'q bo'lsa `null`).
- Event: `{action:'event', event:{action}}` — `nodeconnect` → `device.connectivity`; `addnode` → `device.added`; `changenode` → `device.changed`; `removenode` → `device.removed`; boshqasi → `null`.

- [ ] **Step 1: Failing testlar:**
  - `node-id.test.ts`: `parseNodeId('node//abc', {meshInstanceId:'mc1', meshDomainId:''})` → `{meshInstanceId:'mc1', meshDomainId:'', meshNodeId:'abc'}`; `formatNodeId` round-trip; **`parseNodeId rejects foreign domain`** — `'node/other/abc'` → `AdapterError` `code === 'scope_denied'`; `'user//abc'` va `'node/x'` → `invalid_upstream_message`.
  - `rights.test.ts`: `rightsFor('view') === 3848`, `rightsFor('control') === 3592`; ikkalasida `(r & 7) === 0`, `(r & 16) === 0`, `(r & 0x20000) === 0`; view'da `(r & 256) !== 0`, control'da `=== 0`.
  - `map-nodes.test.ts`: `nodes.json` fixture → uzunligi va `pc-01` snapshot'i (`agentOnline:false`, `hostname:'pc-01.lan'`); sintetik `conn:1,pwr:1` → `agentOnline:true, powerState:'on'`; `pwr:6` → `'off'`; `nodes` maydoni yo'q → `[]` emas, `AdapterError('invalid_upstream_message')`.
  - `map-events.test.ts`: uchala fixture → mos `type`; sintetik `nodeconnect {conn:1,pwr:1}` → `device.connectivity` online; **`parseDeviceEvent returns null for unknown actions and malformed payloads`** — `{action:'event', event:{action:'login'}}`, `{}`, `null`, `'x'`, `{action:'event'}` → hammasi `null`, throw yo'q; boshqa domain nodeid → `null`.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Yuqoridagi signaturalarni amalga oshiring; kirishlarni zod bilan tekshiring (adapter ichida).
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(meshcentral-adapter): node id, rights and message mapping`.

### Task 5: `MeshControlClient` — persistent WS

**Files:**
- Create: `packages/meshcentral-adapter/src/control-client.ts`
- Modify: `packages/meshcentral-adapter/package.json` — dependencies `ws`, `zod`, `@netschool/domain`; devDependencies `@types/ws`, `selfsigned`
- Test: `packages/meshcentral-adapter/test/control-client.test.ts`, `test/support/fake-mesh-server.ts` (`ws` + `https` + `selfsigned`, `CN=localhost`)

**Interfaces:**
- Consumes: `AdapterError` (Task 4).
- Produces:

```typescript
export interface MeshControlClientOptions {
  url: string; username: string; password: string;
  ca: string | Buffer;                 // majburiy; tizim CA'lari bilan almashtirilmaydi
  servername?: string;                 // default: URL hostname
  requestTimeoutMs?: number;           // default 10_000
  maxMessageBytes?: number;            // default 4 * 1024 * 1024
  reconnect?: { minDelayMs: number; maxDelayMs: number }; // default 1_000 / 30_000, exponential + full jitter
}
export interface MeshRequester {
  request<T = Record<string, unknown>>(action: string, payload?: Record<string, unknown>): Promise<T>;
  onMessage(handler: (msg: unknown) => void): Unsubscribe;   // so'rovga bog'lanmagan xabarlar
  onResync(handler: () => void): Unsubscribe;                 // har muvaffaqiyatli qayta ulanishdan keyin
}
export class MeshControlClient implements MeshRequester {
  constructor(opts: MeshControlClientOptions);
  connect(): Promise<void>;   // 'serverinfo' xabari kelganda resolve
  close(): Promise<void>;     // reconnect to'xtaydi, pending → 'upstream_unavailable'
}
```

Xatti-harakat: `request` `{action, ...payload, responseid: randomUUID()}` yuboradi; bir xil `responseid` li javob keladi → `result` yo'q yoki `'ok'` bo'lsa resolve, boshqa `result` → `upstream_rejected` (`detail: result`). Auth muvaffaqiyatsizligi Task 3 `auth-failure.md` dagi signalga ko'ra `upstream_auth_failed` (auth xatosida reconnect qilinmaydi). TLS xatosi → `upstream_tls_failed`.

- [ ] **Step 1: Failing testlar** (fake server bilan):
  - `sends x-meshauth and resolves connect after serverinfo`.
  - `correlates concurrent responses delivered out of order` — 3 so'rov, javoblar teskari tartibda → har biri o'z javobini oladi.
  - `times out with upstream_timeout` — `requestTimeoutMs: 50`, server javob bermaydi.
  - `maps non-ok result to upstream_rejected`.
  - `routes unsolicited messages to onMessage`.
  - **`rejects pending requests and emits resync after reconnect`** — server ulanishni uzadi → pending `upstream_unavailable` bilan rad; server qayta qabul qiladi → `onResync` bir marta chaqiriladi, keyingi `request` ishlaydi.
  - **`drops oversized frames and reconnects`** — `maxMessageBytes: 1024`, server 2 KiB yuboradi → handler chaqirilmaydi, ulanish qayta o'rnatiladi.
  - `fails closed on untrusted certificate` — boshqa CA berilsa → `upstream_tls_failed`; `servername: 'evil.test'` → `upstream_tls_failed`.
  - `does not reconnect after auth failure` va `close() stops reconnecting`.
  - Testlar `vi.useFakeTimers()` emas, kichik delay'lar bilan (`minDelayMs: 10`).
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** `ws` `WebSocket(url, { ca, servername, maxPayload: maxMessageBytes, headers: { 'x-meshauth': ... } })`; `rejectUnauthorized` umuman uzatilmaydi (default `true`).
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(meshcentral-adapter): persistent control.ashx client`.

### Task 6: Inventory va session principal'lar

**Files:**
- Create: `packages/meshcentral-adapter/src/device-management.ts`, `src/principals.ts`, `src/index.ts`
- Test: `packages/meshcentral-adapter/test/{device-management,principals}.test.ts` (fake `MeshRequester`)

**Interfaces:**
- Consumes: `MeshRequester` (Task 5), mapping (Task 4), `DeviceManagementPort` (Task 2).
- Produces:

```typescript
export class MeshCentralDeviceManagement implements DeviceManagementPort {
  constructor(client: MeshRequester, sites: ReadonlyMap<string, SiteMeshScope>);
  listDevices(siteId: string): Promise<DeviceSnapshot[]>;          // noma'lum siteId → AdapterError('scope_denied')
  subscribeDeviceEvents(handler: (e: DeviceEvent) => void): Unsubscribe; // resync → { type: 'resync' }
}
export interface SessionPrincipal { userId: string; username: string; password: string; nodeId: string; rights: number }
export class MeshCentralPrincipals {
  constructor(client: MeshRequester);
  create(device: UpstreamDeviceRef, mode: 'view' | 'control'): Promise<SessionPrincipal>;
  revoke(userId: string): Promise<void>;   // 'User not found' turidagi javob ham muvaffaqiyat (idempotent)
}
```

- `create`: `username = 'ns-sess-' + randomUUID()` (kichik harf, `~` va `/` yo'q), `password` = 32 bayt `randomBytes` base64url; `adduser { username, pass, randomPassword: true, siteadmin: 0 }`; so'ng `adddeviceuser { userids: ['user/<domain>/<username>'], nodeid: formatNodeId(device), rights: rightsFor(mode) }`. Ikkinchi qadam xato bo'lsa `deleteuser` bilan kompensatsiya qilib, asl xatoni qayta otadi.
- `revoke`: `deleteuser { userid }`.

- [ ] **Step 1: Failing testlar:**
  - `listDevices maps nodes for the site scope` — fake `nodes` javobi (fixture) → snapshot'lar; `listDevices('unknown')` → `scope_denied`.
  - `subscribeDeviceEvents forwards mapped events and resync`; unsubscribe'dan keyin chaqirilmaydi; `null` qaytgan eventlar uzatilmaydi.
  - `create sends adduser then adddeviceuser with view rights 3848` — yuborilgan payload'lar aynan tekshiriladi, `siteadmin: 0`.
  - `create compensates with deleteuser when the grant fails`.
  - `revoke is idempotent`.
- [ ] **Step 2:** `pnpm test` → FAIL. **Step 3:** amalga oshiring. **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(meshcentral-adapter): device inventory, events and scoped session principals`.

### Task 7: Real MeshCentral'ga qarshi contract testlar va CI

**Files:**
- Create: `tests/contracts/adapter.test.ts`
- Modify: `.github/workflows/ci.yml` — `contract` job

**Interfaces:**
- Consumes: `startMeshCentral` (Task 3), adapter public API (Task 5–6).

- [ ] **Step 1: Testlar** (`beforeAll` bitta instance, admin bilan `createmesh meshtype:3` va ikki local device `pc-01`, `pc-02`):
  - `connects with valid credentials and the instance CA`.
  - `rejects wrong password with upstream_auth_failed`.
  - `rejects a foreign CA with upstream_tls_failed`.
  - `lists both local devices as offline` — `agentOnline: false`.
  - `emits device.added when a device is added` — 3-qurilma qo'shiladi, 10 s ichida event.
  - **`principal sees only the granted node`** — `create(pc-01, 'view')`, principal o'z login/paroli bilan alohida `MeshControlClient` ochadi → `listDevices` faqat `pc-01`.
  - `principal has no site rights` — principal `adduser` yuborsa `upstream_rejected`.
  - `revoked principal can no longer authenticate` — `revoke` → yangi ulanish `upstream_auth_failed`.
  - `adapter resyncs after MeshCentral restart` — `instance.restart()` → `resync` event va `listDevices` ishlaydi.
- [ ] **Step 2:** `pnpm test:contract` → avval amalga oshirishdagi farqlar tufayli FAIL bo'lsa, sababini Task 4–6 da tuzating (testni yumshatmang).
- [ ] **Step 3:** `pnpm test:contract` → PASS.
- [ ] **Step 4:** CI `contract` job: `checkout` `submodules: true`, Node 24, `pnpm install --frozen-lockfile`, `pnpm meshcentral:install`, `pnpm test:contract`; `npm` cache `infra/meshcentral/upstream/package-lock.json` bo'yicha.
- [ ] **Step 5:** Commit `test(contracts): adapter contract suite against pinned MeshCentral`.

### Task 8: Hujjatlar

**Files:**
- Create: `docs/adr/0002-meshcentral-adapter-protocol.md`
- Modify: `README.md` (Tuzilma jadvali: `packages/domain`, `packages/contracts`, `packages/meshcentral-adapter`, `tests/contracts`; "Ishlab chiqish" bo'limi: `pnpm install`, `pnpm meshcentral:install`, `pnpm test`, `pnpm test:contract`)

- [ ] **Step 1:** ADR 0002: auth usuli (`x-meshauth`), `responseid` correlation, rights qiymatlari (3848/3592) va sababi, principal per sessiya modeli, reconnect/resync, auth xatosi signali (Task 3 fakti), ochiq savollar P0b uchun: `deleteuser` faol desktop WS'ni uzadimi, login token bilan iframe, relay majburiyligi.
- [ ] **Step 2:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:contract` → hammasi exit 0.
- [ ] **Step 3:** Commit `docs: record adapter protocol decisions`.

## P0a tugash mezoni

- Unit va contract suite yashil, CI ikkala job yashil.
- Principal izolyatsiyasi (faqat grant qilingan node) va TLS fail-closed real serverda isbotlangan.
- ADR 0002 P0b uchun ochiq savollarni sanaydi → P0b batafsil rejasi shu savollardan boshlanadi.
