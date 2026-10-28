# P1b — Devices va enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maktab admini bir martalik enrollment token yaratadi; qurilma (Companion) o'zida yaratilgan Ed25519 kalit bilan ro'yxatdan o'tadi, imzolangan heartbeat va capability hisobotini yuboradi; admin qurilmani xonaga biriktiradi va MeshAgent node'iga qo'lda tasdiqlab bog'laydi; teacher o'z xonasidagi qurilmalarni readiness bilan ko'radi.

**Architecture:** Yangi `apps/api/src/modules/devices` Nest moduli (enrollments, device auth, presence, admin). Qurilma so'rovlari cookie'siz: har so'rov Ed25519 imzosi bilan (`x-ns-device-*` headerlar), replay monoton timestamp bilan to'xtatiladi. Ruxsatlar `packages/domain` `authorize()`ga yangi action'lar sifatida; Companion presence hisobi ham domain'da sof funksiya. MeshCentral bilan faqat `DeviceManagementPort` orqali (`reconcileEnrollment` qo'shiladi); API testlarida fake port, adapter esa real MeshCentral'ga qarshi contract testda.

**Tech Stack:** P1a bilan bir xil (NestJS 11, Drizzle 0.45, zod 4, PGlite/PostgreSQL 17); kriptografiya faqat `node:crypto` (Ed25519, SHA-256), yangi dependency yo'q.

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md) §5.1, §6 (enrollment), §7 (capability javobi), §8 (Devices moduli, invariantlar), §9 (`/enrollments`, `/enrollments/claim`, `/rooms/{roomId}/devices`, error kodlari). Yo'l xaritasi: [2026-10-27-netschool-roadmap.md](2026-10-27-netschool-roadmap.md) (P1b qatori). Oldingi qarorlar: [ADR 0002](../../adr/0002-meshcentral-adapter-protocol.md), [ADR 0004](../../adr/0004-school-hub-api.md).

**P0c bog'liqligi (qaror):** P0c hali bajarilmagan. P1b capability'ni faqat qurilma hisobotidan saqlaydi va ko'rsatadi; server hech bir OS'ni "certified" deb belgilamaydi va capability'dan ruxsat chiqarmaydi (bu P1c/P1d). MeshAgent↔Companion bog'lash avtomatik emas, admin tasdig'i bilan (§6). Agent o'rnatish manifesti va oflayn agent cache P0c'da qoladi.

## Global Constraints

- Yo'l xaritasidagi "Umumiy cheklovlar" va P1a plan Global Constraints to'liq amal qiladi (xato konverti, correlation ID, audit mutatsiya bilan bitta tranzaksiyada, `@Inject` tokenlar, zod validatsiya, kod identifikatorlari inglizcha, docs o'zbekcha).
- Enrollment token: `nse_` + 32 tasodifiy bayt base64url; DB'da faqat SHA-256; bir martalik; TTL `expiresInMinutes` 5…1440, default 60. Token faqat yaratish javobida bir marta qaytadi, hech qachon log/audit'ga tushmaydi.
- Qurilma kaliti: Ed25519, public key SPKI DER base64url (`createPublicKey({format:'der', type:'spki'})`, `asymmetricKeyType === 'ed25519'`); `key_fingerprint` = SHA-256 hex, butun hub bo'yicha unique (retired qurilmalar ham hisobda).
- Claim proof: `proof` = Ed25519 imzo, xabar `NSCLAIM1\n<token>\n<publicKey>` (UTF-8).
- Imzolangan qurilma so'rovi: headerlar `x-ns-device-id` (uuid), `x-ns-timestamp` (ms, butun son), `x-ns-signature` (base64url). Xabar: `NSDEV1\n<METHOD>\n<path+query>\n<timestamp>\n<sha256 hex of raw body bytes>`. Qabul: `|now − ts| ≤ 30000` va `ts > devices.last_signed_ts` (atomik `UPDATE … WHERE last_signed_ts IS NULL OR last_signed_ts < ts`), qurilma retired emas. Har qanday xato → 401 `unauthenticated`, sabab javobda yo'q.
- Qurilma marshrutlari (`@DeviceRoute()`): sessiya cookie va `Origin` talab qilmaydi; cookie o'qilmaydi; `ctx.actor` yo'q.
- Heartbeat: interval 10 s (javobda `heartbeatIntervalSeconds: 10`); presence `online` agar `now − lastHeartbeatAt < 30000`, aks holda `stale`; hech heartbeat bo'lmasa `never`.
- Claim IP cheklovi: 30 urinish/daqiqa → 429 (`LoginThrottle` alohida instance).
- `mesh_bindings` unique `(mesh_instance_id, mesh_domain_id, mesh_node_id)`; bitta device — bitta binding. `mesh_instance_id` config'dan (`MESH_INSTANCE_ID`, default `local`), `mesh_domain_id` site'dan (`sites.mesh_domain_id`, null = sozlanmagan, sozlanganlari hub bo'yicha unique).
- Yangi error kodlari: `capability_unavailable` 409, `upstream_unavailable` 503. Boshqa yangi kod yo'q.
- Audit action nomlari: `enrollment.create`, `enrollment.revoke`, `device.claim` (muvaffaqiyatsiz claim `organization_id` null bo'lishi mumkin), `device.assign_room`, `device.retire`, `device.bind`, `device.unbind`, `site.configure_mesh`. Heartbeat va capability hisobotlari audit qilinmaydi (shovqin), capability o'zgarishi esa `device.capabilities_changed`.
- MeshCentral compose ulanishi (service account) P1d'da gateway bilan birga; P1b'da `MESHCENTRAL_URL` berilmasa binding endpointlari 409 `capability_unavailable`.

## Review Focus

1. **Token poygasi va qayta ishlatish** — bitta token bilan 10 ta parallel claim aniq bitta qurilma yaratadi, qolganlari 401; muddati aniq tugagan (`now === expiresAt`) yoki bekor qilingan token 401. → Task 6 testlari `parallel claims with one token create exactly one device`, `token is rejected at expiry and after revoke`.
2. **Site/tashkilot chegarasi** — A site admini B site qurilmasini ko'ra olmaydi, B xonasiga biriktira olmaydi, B node'ini bog'lay olmaydi (403, audit); qurilmani boshqa site xonasiga biriktirish DB FK bilan ham to'xtaydi. → Task 4 `device room must belong to device site`, Task 8 `site admin cannot touch another site's devices`.
3. **Imzo replay va soat** — bir xil timestamp bilan qayta yuborilgan heartbeat, ±30 s'dan tashqaridagi timestamp, boshqa qurilma kaliti bilan imzo, o'zgartirilgan body, retired qurilma — hammasi 401. → Task 5 testlari.
4. **Bitta node'ni ikki marta bog'lash** — ikki qurilmaga bir node parallel bog'lansa biri 200, biri 409; node boshqa domain'da yoki topilmasa bog'lanmaydi. → Task 9 `a mesh node binds to at most one device`.
5. **Presence chegarasi va MeshCentral uzilishi** — 29 999 ms `online`, 30 000 ms `stale`; MeshCentral javob bermasa qurilmalar ro'yxati baribir 200 va `agent: unknown`. → Task 1 `presence boundary`, Task 9 `device list survives MeshCentral outage`.

---

### Task 0: Branch

- [x] **Step 1:** Stacked: `git switch p1a-school-hub && git switch -c p1b-devices-enrollment` (bajarilgan).

### Task 1: Domain — device ruxsatlari va presence

**Files:**
- Modify: `packages/domain/src/access/authorize.ts`
- Create: `packages/domain/src/presence.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/authorize.test.ts`, `packages/domain/test/presence.test.ts`

**Interfaces:**
- Produces:

```typescript
// authorize.ts — Action'ga qo'shiladi
| 'device.read' | 'device.enroll' | 'device.manage' | 'site.configure_mesh'
// presence.ts
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const STALE_AFTER_MS = 30_000;
export type CompanionPresence = 'online' | 'stale' | 'never';
export function companionPresence(lastHeartbeatAt: number | null, now: number): CompanionPresence;
```
- Qoidalar: org-wide school_admin — hammasi (P1a kabi). Site school_admin — o'z site'ida `device.read|enroll|manage`. it_support — o'z site'ida `device.read`, `device.enroll`. teacher — `device.read` faqat `target.roomId` o'z `roomIds`ida bo'lsa. student — hech narsa. `site.configure_mesh` — faqat org-wide school_admin (hech qaysi site to'plamiga qo'shilmaydi).

- [ ] **Step 1: Failing testlar:** authorize jadvaliga yangi action'lar (rol × action × scope, P1a jadval uslubida), xususan `it_support cannot manage devices`, `teacher reads devices only in assigned rooms`, `site admin cannot configure mesh domain`; `presence.test.ts`: `presence boundary` (`null`→`never`, 29 999→`online`, 30 000→`stale`, kelajakdagi heartbeat (soat orqaga ketgan) → `online`).
- [ ] **Step 2:** `pnpm test -- packages/domain` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test -- packages/domain`, `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(domain): device permissions and companion presence`.

### Task 2: Adapter — `reconcileEnrollment`

**Files:**
- Modify: `packages/domain/src/devices.ts`, `packages/domain/src/ports/device-management.ts`, `packages/meshcentral-adapter/src/device-management.ts`
- Test: `tests/contracts/adapter.test.ts`, `packages/meshcentral-adapter/test/device-management.test.ts` (unit, fake `MeshRequester`)

**Interfaces:**
- Produces:

```typescript
// domain/devices.ts
export interface DeviceBinding { siteId: string; deviceId: string; upstream: UpstreamDeviceRef }
export type EnrollmentResult = { status: 'bound'; snapshot: DeviceSnapshot } | { status: 'node_not_found' };
// port
reconcileEnrollment(binding: DeviceBinding): Promise<EnrollmentResult>;
```
- Adapter: site scope topilmasa yoki `upstream.meshInstanceId/meshDomainId` site scope'ga mos kelmasa `AdapterError('scope_denied')`; aks holda `nodes` so'rovidan node qidiradi. Upstream'da hech narsa o'zgartirmaydi.

- [ ] **Step 1: Failing testlar:** unit: `binding from another domain is scope_denied`, `missing node is node_not_found`; contract: `reconcileEnrollment binds an existing node`, `reconcileEnrollment reports an unknown node id`.
- [ ] **Step 2:** `pnpm test -- packages/meshcentral-adapter` → FAIL; `pnpm test:contract -- adapter` → FAIL.
- [ ] **Step 3:** Implement (`listDevices` bilan bir xil `mapNodesResponse` yo'li).
- [ ] **Step 4:** Ikkala buyruq → PASS; `pnpm typecheck` → 0.
- [ ] **Step 5:** Commit `feat(adapter): verify a mesh node before binding`.

### Task 3: Contracts — device API sxemalari

**Files:**
- Create: `packages/contracts/src/api/v1/devices.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/devices.test.ts`

**Interfaces:**
- Produces (zod; nomlar `…Schema`, tiplar `z.infer`):
  - `createEnrollmentRequestSchema` `{ siteId: uuid, roomId?: uuid, expiresInMinutes?: int 5..1440 }`; `enrollmentSchema` `{ id, siteId, roomId|null, status: 'pending'|'claimed'|'expired'|'revoked', expiresAt, createdAt, deviceId|null }`; `createEnrollmentResponseSchema` = `enrollmentSchema` + `token`.
  - `claimRequestSchema` strict `{ token: /^nse_[A-Za-z0-9_-]{43}$/, publicKey: base64url 1..128, proof: base64url 1..128, hostname: 1..253 printable ASCII, capabilities: capabilityReportSchema }`; `claimResponseSchema` `{ deviceId, siteId, heartbeatIntervalSeconds: 10 }`.
  - `heartbeatRequestSchema` = `z.strictObject({})`; `heartbeatResponseSchema` `{ heartbeatIntervalSeconds: 10 }`.
  - `capabilityReportSchema`ga `capabilities` uchun maksimal 64 kalit cheklovi qo'shiladi (`packages/contracts/src/capabilities.ts`).
  - `deviceSchema` `{ id, siteId, roomId|null, hostname, enrolledAt, companion: { presence: CompanionPresence, lastHeartbeatAt|null }, agent: 'online'|'offline'|'unknown'|'unbound', capabilities: CapabilityReport|null }`.
  - `assignRoomRequestSchema` `{ roomId: uuid|null }`; `meshBindingRequestSchema` `{ meshNodeId: /^[A-Za-z0-9@$_-]{1,128}$/ }`; `meshDomainRequestSchema` `{ meshDomainId: /^[a-z0-9_-]{0,64}$/ }` (`''` = default domain); `meshNodeSchema` `{ meshNodeId, name, hostname|null, osDescription|null, agentOnline, boundDeviceId|null }`.

- [ ] **Step 1: Failing testlar:** `claim rejects unknown fields and malformed token`, `capability report with 65 keys is rejected`, `mesh node id rejects slashes`.
- [ ] **Step 2:** `pnpm test -- packages/contracts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(contracts): device and enrollment API schemas`.

### Task 4: DB sxema va migratsiya

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0001_*.sql` (`pnpm --filter @netschool/api exec drizzle-kit generate`, qo'lda tahrirlanmaydi)
- Test: `apps/api/test/db-invariants.test.ts`

**Interfaces:**
- Produces (Drizzle jadvallari):
  - `sites.mesh_domain_id text null` + partial unique (`where mesh_domain_id is not null`); `rooms` ga `unique('rooms_site_id').on(siteId, id)`.
  - `enrollments`: `id`, `organization_id`, `site_id`, `room_id null`, `token_hash bytea unique`, `created_by uuid`, `created_at`, `expires_at`, `claimed_at null`, `revoked_at null`, `device_id uuid null unique`. FK `(organization_id, site_id)`→sites, `(site_id, room_id)`→rooms(site_id,id), `(organization_id, created_by)`→users.
  - `devices`: `id`, `organization_id`, `site_id`, `room_id null`, `hostname`, `public_key bytea`, `key_fingerprint text unique`, `enrolled_at`, `last_heartbeat_at null`, `last_signed_ts bigint null`, `retired_at null`; FK `(organization_id, site_id)`→sites, `(site_id, room_id)`→rooms(site_id,id) (xona o'chirish endpointi yo'q, `on delete` qo'yilmaydi); `unique('devices_org_id').on(organizationId, id)`, `unique('devices_site_id').on(siteId, id)`; index `(site_id, room_id)`.
  - `mesh_bindings`: `device_id uuid primary key`, `organization_id`, `site_id`, `mesh_instance_id`, `mesh_domain_id`, `mesh_node_id`, `bound_by uuid`, `bound_at`; unique `(mesh_instance_id, mesh_domain_id, mesh_node_id)`; FK `(site_id, device_id)`→devices(site_id,id) cascade.
  - `device_capabilities`: `device_id uuid primary key`, `organization_id`, `report jsonb`, `reported_at`; FK `(organization_id, device_id)`→devices cascade.
  - `audit_events_org_required` check: `organization_id is not null or action like 'auth.%' or action = 'device.claim'`.

- [ ] **Step 1: Failing testlar:** `device room must belong to device site` (boshqa site xonasi bilan insert → FK xatosi), `mesh node binds to one device` (unique), `binding site must match device site`, `key fingerprint is unique`, `configured mesh domains are unique but many sites may be unconfigured`.
- [ ] **Step 2:** `pnpm test -- apps/api/test/db-invariants` → FAIL.
- [ ] **Step 3:** Sxema + `drizzle-kit generate`.
- [ ] **Step 4:** → PASS; butun `pnpm test` → PASS (P1a testlari migratsiyadan keyin ham yashil).
- [ ] **Step 5:** Commit `feat(api): devices, enrollments and mesh bindings schema`.

### Task 5: Qurilma autentifikatsiyasi (imzolangan so'rovlar)

**Files:**
- Create: `apps/api/src/modules/devices/device-keys.ts`, `apps/api/src/modules/devices/device-auth.guard.ts`, `apps/api/test/support/device.ts`
- Modify: `apps/api/src/common/route-flags.ts` (`DeviceRoute`), `apps/api/src/common/origin-guard.ts`, `apps/api/src/modules/identity/auth.guard.ts`, `apps/api/src/app.ts` (`rawBody: true`)
- Test: `apps/api/test/device-auth.test.ts`
- Unknown `x-ns-device-id` ham 401 (imzo tekshiruvi bilan bir xil javob).

**Interfaces:**
- Produces:

```typescript
// device-keys.ts (sof funksiyalar)
export function parseDevicePublicKey(spkiB64url: string): KeyObject | null; // faqat Ed25519
export function keyFingerprint(spkiDer: Buffer): string; // sha256 hex
export function verifyClaimProof(key: KeyObject, token: string, publicKey: string, proof: string): boolean;
export function deviceSigningInput(method: string, pathWithQuery: string, timestamp: string, rawBody: Buffer): Buffer;
// route-flags.ts
export const DEVICE_ROUTE = 'ns:device';
export const DeviceRoute = () => SetMetadata(DEVICE_ROUTE, true);
// device-auth.guard.ts — @DeviceRoute() + @UseGuards(DeviceAuthGuard) marshrutlarida
export function authenticatedDevice(req: Request): { id: string; organizationId: string; siteId: string };
// test/support/device.ts
export function makeDeviceKey(): { publicKey: string; sign(message: Buffer | string): string };
export function deviceRequest(app: TestApp, key, deviceId: string, method: string, path: string, body?: unknown, timestamp?: number): Promise<TestResponse>;
export async function seedDevice(db: Db, orgId: string, siteId: string, publicKey: string, opts?: { roomId?: string; hostname?: string }): Promise<string>; // claim Task 6'da, shuning uchun bu yerda to'g'ridan-to'g'ri insert
```
- `AuthGuard` va `OriginGuard` `DEVICE_ROUTE` bo'lsa o'tkazib yuboradi. Claim marshruti ham `@DeviceRoute()` (lekin `DeviceAuthGuard`siz).

- [ ] **Step 1: Failing testlar** (test-only controller `POST /api/v1/device/echo`): `signed request is accepted`, `replayed timestamp is rejected`, `timestamp outside 30s window is rejected`, `signature by another device key is rejected`, `tampered body is rejected`, `retired device is rejected`, `device route needs no Origin and ignores session cookies`, `non-device route still requires Origin`; `device-keys`: `rsa and malformed keys are refused`.
- [ ] **Step 2:** `pnpm test -- apps/api/test/device-auth` → FAIL.
- [ ] **Step 3:** Implement. Timestamp + fingerprint tekshiruvi bitta `UPDATE devices SET last_signed_ts = $ts WHERE id = $id AND retired_at IS NULL AND (last_signed_ts IS NULL OR last_signed_ts < $ts) RETURNING …` — imzo tekshiruvi undan **oldin** (imzosiz so'rov holatni o'zgartirmaydi).
- [ ] **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): Ed25519-signed device requests with replay protection`.

### Task 6: Enrollment — yaratish, ro'yxat, bekor qilish, claim

**Files:**
- Create: `apps/api/src/modules/devices/{enrollments.service.ts,enrollments.controller.ts,devices.module.ts}`
- Modify: `apps/api/src/app.ts` (`DevicesModule`), `apps/api/src/common/errors.ts` (`capability_unavailable` 409, `upstream_unavailable` 503)
- Test: `apps/api/test/enrollments.test.ts`

**Interfaces:**
- Consumes: Task 3 sxemalari, Task 5 `parseDevicePublicKey`, `keyFingerprint`, `verifyClaimProof`, `DeviceRoute`.
- Produces: `POST /api/v1/enrollments` → 201 `createEnrollmentResponse` (`device.enroll`, room site'ga tegishli bo'lmasa 403); `GET /api/v1/sites/{siteId}/enrollments` → `enrollment[]` (`device.enroll`); `DELETE /api/v1/enrollments/{id}` → 204 (`device.enroll`, faqat `pending`, aks holda 409); `POST /api/v1/enrollments/claim` → 201 `claimResponse`.
- Claim: bitta tranzaksiyada `UPDATE enrollments SET claimed_at = now WHERE token_hash = $h AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > now RETURNING …` → `devices` insert (room enrollment'dan) → `enrollments.device_id` → `device_capabilities` → audit `device.claim` succeeded. Token topilmasa/eskirgan/proof xato/kalit Ed25519 emas → 401 va audit `device.claim` failed (`details.reason`: `invalid_token`|`invalid_proof`), tashkilot ma'lum bo'lsa `organization_id` bilan. Fingerprint takrori → 409.

- [ ] **Step 1: Failing testlar:** `admin creates a one-time token shown once` (ro'yxatda token yo'q, DB'da faqat hash), `it_support enrolls in own site only`, `teacher cannot create enrollments`, `device claims with token, key and proof`, `parallel claims with one token create exactly one device`, `token is rejected at expiry and after revoke`, `claim with wrong proof is rejected and audited`, `reusing a device key is a conflict`, `claim is rate limited per IP`, `enrollment room from another site is denied`.
- [ ] **Step 2:** `pnpm test -- apps/api/test/enrollments` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): one-time enrollment tokens and device claim`.

### Task 7: Heartbeat va capability hisoboti

**Files:**
- Create: `apps/api/src/modules/devices/{presence.service.ts,device-channel.controller.ts}`
- Test: `apps/api/test/device-presence.test.ts`

**Interfaces:**
- Consumes: Task 5 `DeviceAuthGuard`, `authenticatedDevice`; Task 1 `HEARTBEAT_INTERVAL_MS`.
- Produces: `POST /api/v1/device/heartbeat` → 200 `{ heartbeatIntervalSeconds: 10 }`, `last_heartbeat_at = now`; `PUT /api/v1/device/capabilities` (body `capabilityReport`) → 204; hisobot avvalgisidan farq qilsa upsert + audit `device.capabilities_changed` (`details`: o'zgargan kalitlar ro'yxati), bir xil bo'lsa faqat `reported_at`.

- [ ] **Step 1: Failing testlar:** `heartbeat updates last seen`, `capability change is stored and audited once`, `identical capability report is not audited`, `invalid capability report is 400 and changes nothing`.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(api): device heartbeat and capability reports`.

### Task 8: Qurilmalarni boshqarish — ro'yxat, xona, retire

**Files:**
- Create: `apps/api/src/modules/devices/{devices.service.ts,devices.controller.ts}`
- Test: `apps/api/test/devices.test.ts`

**Interfaces:**
- Consumes: Task 1 `companionPresence`, Task 3 `deviceSchema`.
- Produces: `DevicesService.list(ctx, { siteId } | { roomId }): Promise<Device[]>` (Task 9 `agent` maydonini to'ldiradi; bu taskda binding bo'lsa `unknown`, bo'lmasa `unbound`); `GET /api/v1/rooms/{roomId}/devices` (`device.read` + roomId), `GET /api/v1/sites/{siteId}/devices` (`device.read`, roomId'siz — teacher rad); `PUT /api/v1/devices/{id}/room` (`device.manage`; room device site'ida bo'lmasa 403 audit bilan); `DELETE /api/v1/devices/{id}` → 204 retire (`retired_at`, binding o'chiriladi, audit). Retired qurilmalar ro'yxatlarda yo'q. Begona/noma'lum/noto'g'ri ID — P1a kabi bir xil 403.

- [ ] **Step 1: Failing testlar:** `teacher lists devices in assigned room with presence`, `teacher cannot list site devices or other rooms`, `site admin cannot touch another site's devices`, `assigning a room from another site is denied and audited`, `retired device disappears and cannot heartbeat`.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): device listing with readiness, room assignment and retire`.

### Task 9: MeshAgent bog'lash va MeshCentral ulanishi

**Files:**
- Create: `apps/api/src/modules/devices/{mesh.ts,mesh-binding.service.ts,mesh-binding.controller.ts}`
- Modify: `apps/api/src/config/config.ts`, `apps/api/src/main.ts`, `apps/api/src/app.ts` (`CreateAppOptions.deviceManagement?`), `apps/api/src/modules/devices/devices.service.ts` (`agent` maydoni), `apps/api/test/support/app.ts`
- Test: `apps/api/test/mesh-binding.test.ts`, `apps/api/test/errors.test.ts` (mavjud `loadConfig` testlari yonida)

**Interfaces:**
- Consumes: Task 2 `reconcileEnrollment`, `DeviceBinding`, `EnrollmentResult`.
- Produces:

```typescript
// mesh.ts
export const DEVICE_MANAGEMENT = Symbol('DEVICE_MANAGEMENT');
export type SiteScope = { meshInstanceId: string; meshDomainId: string };
export type DeviceManagementFactory = (scopes: ReadonlyMap<string, SiteScope>) => DeviceManagementPort;
// null = MeshCentral sozlanmagan → binding endpointlari 409 capability_unavailable
// config.ts
mesh: { url: string; username: string; password: string; ca: string; instanceId: string } | null;
// env: MESHCENTRAL_URL, MESHCENTRAL_USERNAME, MESHCENTRAL_PASSWORD(_FILE), MESHCENTRAL_CA_FILE, MESH_INSTANCE_ID (default 'local'); URL berilsa qolganlari majburiy
```
- `main.ts`: `config.mesh` bo'lsa `MeshControlClient` (`requestTimeoutMs: 3000`) yaratib `connect()` qiladi (ulanmasa ham API ishga tushadi; adapter o'zi reconnect qiladi), factory = `(scopes) => new MeshCentralDeviceManagement(client, scopes)`; shutdown'da `close()`.
- Endpointlar: `PUT /api/v1/sites/{siteId}/mesh-domain` (`site.configure_mesh`; site'da binding bo'lsa 409); `GET /api/v1/sites/{siteId}/mesh-nodes` → `meshNode[]` (`device.manage`); `PUT /api/v1/devices/{id}/mesh-binding` (`device.manage`) → 200 `device`: site domain'i yo'q yoki factory null → 409 `capability_unavailable`; `node_not_found` → 409 `conflict`; adapter xatosi/timeout → 503 `upstream_unavailable`; boshqa node bilan bog'langan qurilma → 409; xuddi shu node → 200 (idempotent); unique buzilishi → 409; audit `device.bind` (`details.meshNodeId`). `DELETE /api/v1/devices/{id}/mesh-binding` → 204, audit `device.unbind`.
- `DevicesService.list`: bog'langan qurilma bo'lsa site uchun bitta `listDevices(siteId)`; node online → `online`, topilmasa yoki offline → `offline`, xato → `unknown` (ro'yxat baribir 200).

- [ ] **Step 1: Failing testlar** (fake `DeviceManagementPort`): `mesh binding requires a configured site domain`, `admin binds a device to a verified node`, `a mesh node binds to at most one device` (parallel), `binding an unknown node is a conflict`, `MeshCentral outage returns upstream_unavailable`, `device list survives MeshCentral outage`, `agent state follows mesh snapshot`, `only an organization admin sets the mesh domain`, `loadConfig requires all MeshCentral settings when the URL is set`.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build:api` → 0; `pnpm test:contract` → PASS.
- [ ] **Step 5:** Commit `feat(api): admin-confirmed MeshAgent binding through the adapter port`.

### Task 10: Hujjatlar

**Files:**
- Create: `docs/adr/0005-devices-enrollment.md`
- Modify: `docs/superpowers/plans/2026-10-27-netschool-roadmap.md` (P1b holati), `infra/compose/README.md` (MeshCentral env'lari P1d'da), `README.md` (kerak bo'lsa)

- [ ] **Step 1:** ADR 0005: enrollment token, Ed25519 kalit va claim proof, imzolangan so'rov sxemasi va replay himoyasi (nega mTLS emas), presence chegaralari, admin tasdiqlaydigan binding va site → mesh domain, yangi error kodlari, P0c bog'liqligi va P1b'da yo'q narsalar (WS kanal — P1c; agent online eventlari — P1c events; compose MeshCentral service account — P1d; device rename/ko'chirish).
- [ ] **Step 2:** `pnpm lint` → 0.
- [ ] **Step 3:** Commit `docs: record device enrollment decisions`.
