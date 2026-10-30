# P1d — Remote sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teacher o'z darsidagi qurilmaga `view` yoki `control` remote desktop sessiyasini ochadi; bitta qurilmada bir paytda bitta boshqaruvchi (control lease, fencing); sessiya yangilanmasa, dars tugasa, qurilma darsdan chiqsa yoki teacher yopsa — gateway soketlari uziladi va MeshCentral principal'i o'chiriladi; API qayta ishga tushsa osilib qolgan sessiya va principal'lar tozalanadi.

**Architecture:** P0b `packages/session-gateway` broker/registry/ticket'lari **API jarayoni ichida** ikkinchi HTTPS listener'da (`GATEWAY_PORT`, default 8444) ishlaydi: registry xotirada, revoke darhol; notifier/workerlar ham bitta jarayonda (ADR 0006). Teacher web bilan bir host, boshqa port → same-site (gateway cookie `SameSite=Strict` ishlaydi), lekin boshqa origin (viewer'ning `/scripts/`, `/control.ashx` yo'llari teacher web bilan to'qnashmaydi — ADR 0003 framing sharti). Yangi `apps/api/src/modules/remote-sessions/`. Sessiya va lease DB'da (`remote_sessions`, `control_leases`); MeshCentral chaqiruvi tranzaksiyadan tashqarida: `opening` qatori + lease commit → broker.open → `active`. Yopish har doim DB'da (sababi bilan tranzaksiyada) + outbox `remote.revoke` → worker broker.close (tranzaksiyadan tashqarida, qayta urinish bilan).

**Tech Stack:** P1c bilan bir xil (NestJS 11, Drizzle 0.45, zod 4, PGlite/PostgreSQL 17, ws 8); yangi dependency yo'q. `@netschool/session-gateway` va `@netschool/meshcentral-adapter` `apps/api` dependency'siga qo'shiladi (workspace).

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md) §5.2 (remote desktop oqimi 1–7), §8 (Remote Sessions; bitta control lease, fencing), §9 (`POST /lessons/{id}/remote-sessions`, `DELETE /remote-sessions/{id}`, `409 control_busy`), §10 (control lease 30 s / 10 s; ticket 30 s bir marta; server o'chsa sessiya lease expiry'da tugaydi), §13 (gateway'ni aylanib o'tish yo'q), §15.1 (qabul). Yo'l xaritasi: [2026-10-27-netschool-roadmap.md](2026-10-27-netschool-roadmap.md) (P1d). Oldingi qarorlar: [ADR 0003](../../adr/0003-session-gateway.md), [ADR 0005](../../adr/0005-devices-enrollment.md), [ADR 0006](../../adr/0006-lessons-commands.md).

## Global Constraints

- P1a–P1c Global Constraints amal qiladi (xato konverti, correlation ID, audit bitta tranzaksiyada, begona/noma'lum ID → bir xil audit qilingan 403, `@Inject` tokenlar, zod, kod inglizcha, docs o'zbekcha, MeshCentral faqat adapterda, TLS tekshiruvi o'chirilmaydi).
- Rejim: `view` | `control`. Principal huquqlari `VIEW_RIGHTS` / `CONTROL_RIGHTS` (adapter `rights.ts`, o'zgarmaydi).
- Control lease: **30 s**, client har **10 s** `renew` qiladi. Bitta qurilmada bitta lease (`control_leases` PK `device_id`). Har olishda yangi `fencing` (global monoton `control_fencing_seq`, string sifatida). Renew `fencing` mos va lease muddati o'tmagan bo'lsa ishlaydi, aks holda 409 `conflict` — eskirgan controller hech narsani uzaytira olmaydi. `view` sessiyada lease yo'q, lekin sessiya muddati ham 30 s va xuddi shunday `renew` bilan uzayadi.
- Band qurilmaga ikkinchi `control` → **409 `control_busy`** (yangi error kodi), hech narsa yozilmaydi va MeshCentral'ga murojaat yo'q. `view` lease talab qilmaydi (bir nechta `view` + bitta `control` mumkin).
- Ochish darvozasi (tartib bilan): dars `active` va actor egasi (yoki admin) → qurilma shu darsning faol `lesson_devices` a'zosi (aks holda 403 audit bilan) → MeshCentral sozlangan, site'da `mesh_domain_id` va qurilmada `mesh_bindings` bor (aks holda 409 `capability_unavailable`) → Companion hisobotida `remote.desktop` kaliti bo'lsa va `state !== 'available'` → 409 `capability_unavailable` (kalit yo'q — MeshAgent manba, ruxsat) → MeshCentral snapshot `agentOnline` (aks holda 503 `device_offline`) → `control` bo'lsa lease (aks holda 409 `control_busy`).
- Ticket: 32 bayt, TTL **30 s**, bir marta (P0b `TicketStore`). DB'ga, auditga, logga yozilmaydi; `Idempotency` javobida ham bo'lmaydi. Viewer URL: `${GATEWAY_PUBLIC_ORIGIN}/rs/redeem?ticket=<ticket>`. Reload kirish yo'lida rad etiladi (ADR 0003) — client yangi ticket oladi.
- `remote_sessions.status`: `opening → active → closed`; `opening → closed`. `close_reason`: `teacher` | `admin` | `lesson_ended` | `device_left` | `lease_expired` | `upstream_failed` | `restart`. Yopilgan sessiya qayta ochilmaydi.
- Revoke: yopilish commit'idan keyin gateway soketlari va principal **≤ 2 s** ichida (outbox `remote.revoke` + commit'dan keyin `kick()`).
- MeshCentral principal nomi `ns-sess-<sessionId>` (sessionId — `remote_sessions.id`, UUID). Reconciliation faqat shu prefiksli user'larni o'chiradi; boshqa hech bir MeshCentral user'iga tegilmaydi.
- `Idempotency-Key` majburiy: `POST /lessons/{id}/remote-sessions`. Saqlangan javobda ticket yo'q (yuqorida); replay sessiyaning **joriy** holatini qaytaradi.
- Yangi audit action'lar: `remote_session.open` (details: `mode`, `deviceId`), `remote_session.close` (details: `reason`; timeout/restart'da actor null). Renew va ticket audit emas.
- Yangi event turlari: `remote_session.opened`, `remote_session.closed` (`data`: `sessionId`, `deviceId`, `mode`, `reason?`). Events snapshot'ga darsning faol sessiyalari qo'shiladi.
- Yangi config: `GATEWAY_PORT` (default 8444), `GATEWAY_PUBLIC_ORIGIN` (https origin; `MESHCENTRAL_URL` berilsa majburiy). MeshCentral sozlanmagan bo'lsa gateway ishga tushmaydi va ochish 409 `capability_unavailable`.

## Review Focus

1. **Ikki teacher bitta qurilmani boshqarishga urinadi** (ikki admin yoki admin + teacher parallel) → bittasi `control`, ikkinchisi 409 `control_busy`; muddati o'tgan lease'ni boshqasi oladi va eski controller'ning renew'i (eski `fencing`) 409. → Task 7 `second controller gets control_busy`, `expired lease can be taken and the old fencing is rejected`; real parallellik `concurrency.pg.test.ts` `control lease is exclusive under concurrency`.
2. **Ochilish paytida dars tugashi / qurilma chiqishi** (broker.open hali davom etmoqda) → sessiya `closed`, yangi yaratilgan principal darhol o'chiriladi, ticket berilmaydi, lease bo'shaydi. → Task 7 `lesson ending during open revokes the fresh principal`.
3. **Teacher UI yopiladi / tarmoq uziladi** → renew to'xtaydi, 30 s'da maintenance sessiyani `lease_expired` bilan yopadi, soketlar uziladi, qurilma boshqa teacher uchun bo'shaydi. → Task 8 `unrenewed session expires and frees the device`.
4. **API restart** (gateway xotirasi yo'qoladi) → DB'dagi ochiq sessiyalar `restart` bilan yopiladi, lease'lar o'chadi, `ns-sess-*` principal'lar MeshCentral'dan o'chiriladi; begona user'larga tegilmaydi. → Task 9 `startup closes stale sessions and deletes orphan principals`, Task 3 contract `lists only session principals`.
5. **MeshCentral yo'q yoki xato** (ochishda uzilgan, adduser rad) → 503 `upstream_unavailable`, sessiya `upstream_failed`, lease bo'shaydi, yarim yaratilgan principal qolmaydi; revoke xatosi qayta uriniladi. → Task 7 `upstream failure releases the lease`, Task 8 `failed revoke is retried`.

---

### Task 0: Branch

- [ ] **Step 1:** `git switch main && git pull --ff-only && git switch -c p1d-remote-sessions`; shu reja faylini birinchi commit qilish: `docs: P1d remote sessions plan`.

### Task 1: Domain — remote ruxsatlar va yopilish sabablari

**Files:**
- Modify: `packages/domain/src/access/authorize.ts`, `packages/domain/src/remote-sessions.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/test/authorize.test.ts`, `packages/domain/test/remote-sessions.test.ts`

**Interfaces:**
- Produces:

```typescript
// authorize.ts
Action += 'remote.view' | 'remote.control' | 'remote.manage';
// remote-sessions.ts
export type RemoteSessionStatus = 'opening' | 'active' | 'closed';
export type CloseReason = 'teacher' | 'admin' | 'lesson_ended' | 'device_left' | 'lease_expired' | 'upstream_failed' | 'restart';
export const CONTROL_LEASE_MS = 30_000;
export const REMOTE_RENEW_INTERVAL_MS = 10_000;
export function remoteAction(mode: RemoteMode): 'remote.view' | 'remote.control';
```
- Qoidalar: org admin va site school_admin (o'z site'ida) — uchala action. teacher — `remote.view`, `remote.control` faqat `roomId` o'z xonasida **va** `ownerUserId === actor.userId` (dars egasi); `remote.manage` (boshqaning sessiyasini yopish) yo'q. it_support va student — hech biri (P1d sessiyalar dars doirasida).

- [ ] **Step 1: Failing testlar:** authorize jadvaliga 3 action; `teacher opens remote sessions only in own lesson`; `it_support cannot open lesson remote sessions`; `only admins manage other sessions`; `remoteAction maps modes`.
- [ ] **Step 2:** `pnpm vitest run packages/domain` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; `pnpm typecheck` → 0.
- [ ] **Step 5:** Commit `feat(domain): remote session permissions and close reasons`.

### Task 2: Contracts

**Files:**
- Create: `packages/contracts/src/api/v1/remote-sessions.ts`
- Modify: `packages/contracts/src/api/v1/events.ts` (snapshot + event turlari), `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/remote-sessions.test.ts`

**Interfaces:**
- Produces: `openRemoteSessionRequestSchema` `{ deviceId: uuid, mode: 'view'|'control' }` (strict); `remoteSessionSchema` `{ id, lessonId, deviceId, actorUserId, mode, status, openedAt, expiresAt, closedAt|null, closeReason|null, lease: { fencing: string, expiresAt } | null }`; `renewRemoteSessionRequestSchema` `{ fencing?: string /^\d{1,19}$/ }` (`control` uchun majburiy — servis tekshiradi); `remoteTicketSchema` `{ url: https URL, expiresAt }`; `eventsResponseSchema.snapshot` ga `remoteSessions: remoteSessionSchema[]`; event `type` enum'iga `remote_session.opened`, `remote_session.closed`.

- [ ] **Step 1: Failing testlar:** `mode must be view or control`, `unknown fields are rejected`, `fencing is a decimal string`, `snapshot carries remote sessions`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(contracts): remote session schemas`.

### Task 3: Adapter — sessiya principal'larini nomlash, ro'yxat va tag korrelyatsiyasi

**Files:**
- Modify: `packages/meshcentral-adapter/src/control-client.ts`, `packages/meshcentral-adapter/src/principals.ts`, `packages/meshcentral-adapter/src/desktop/viewer-upstream.ts`, `packages/meshcentral-adapter/src/index.ts`
- Test: `packages/meshcentral-adapter/test/control-client.test.ts`, `packages/meshcentral-adapter/test/principals.test.ts`, `tests/contracts/adapter.test.ts`

**Interfaces:**
- Produces:

```typescript
// control-client.ts — `users` kabi action'lar muvaffaqiyatda responseid emas, `tag`ni qaytaradi (meshuser.js:7541-7551)
request<T>(action: string, payload?: Message, opts?: { correlate?: 'responseid' | 'tag' }): Promise<T>;
// principals.ts
export const SESSION_PRINCIPAL_PREFIX = 'ns-sess-';
create(device: UpstreamDeviceRef, mode: 'view' | 'control', sessionId: string): Promise<SessionPrincipal>; // username = prefix + sessionId
listSessionPrincipals(): Promise<{ userId: string; sessionId: string }[]>; // faqat prefiksli user'lar
```
- `correlate: 'tag'`: so'rovga `tag: <uuid>` qo'shiladi va javob `msg.tag` bo'yicha topiladi; `responseid` bilan kelgan rad javobi (`result: 'Access denied'`) ham shu so'rovni `upstream_rejected` bilan tugatadi (ikkala kalit yuboriladi).
- `MeshCentralViewerUpstream.open(req)` → `principals.create(req.device, req.mode, req.sessionId)`. `sessionId` UUID bo'lmasa `create` `AdapterError('upstream_rejected')` emas, oddiy `TypeError` bilan rad (MeshCentral'ga murojaat yo'q).

- [ ] **Step 1: Failing testlar:** unit — `tag-correlated requests resolve on the tagged reply`, `tagged request fails on an access-denied reply`, `principal username carries the session id`, `listing ignores users without the prefix`. Contract (real MeshCentral) — `lists only session principals` (admin + bir begona user + ikki sessiya principal → faqat ikkalasi, `sessionId`lari bilan; o'chirilgandan keyin bo'sh).
- [ ] **Step 2:** `pnpm test` → FAIL; `pnpm test:contract -t "session principals"` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS (unit va contract; mavjud `gateway.test.ts`, `viewer-upstream.test.ts` ham yashil).
- [ ] **Step 5:** Commit `feat(adapter): session-named principals and listing`.

### Task 4: DB sxema

**Files:**
- Modify: `apps/api/src/db/schema.ts`, `apps/api/test/support/db.ts` (`TABLES`)
- Create: `apps/api/drizzle/0007_*.sql` (drizzle-kit generate; qo'lda tahrirlanmaydi)
- Test: `apps/api/test/db-invariants.test.ts`

**Interfaces:**
- Produces:
  - `remote_sessions`: `id uuid pk`, `organization_id`, `site_id`, `room_id`, `lesson_id`, `device_id`, `actor_user_id`, `mode` (check `view|control`), `status` (check 3 holat), `opened_at`, `expires_at`, `closed_at null`, `close_reason null` (check 7 sabab), `closed_by uuid null`; FK `(site_id, lesson_id)`→lessons(site_id,id), `(site_id, device_id)`→devices(site_id,id), `(organization_id, actor_user_id)`→users; check `status='closed' ⇔ closed_at is not null and close_reason is not null`; partial index `(expires_at) where status <> 'closed'`, partial index `(lesson_id) where status <> 'closed'`, partial index `(device_id) where status <> 'closed'`.
  - `control_leases`: `device_id uuid pk`, `organization_id`, `session_id uuid unique` FK→remote_sessions(id), `fencing bigint not null`, `acquired_at`, `expires_at`.
  - Sequence `control_fencing_seq` (bigint, monoton).

- [ ] **Step 1: Failing testlar:** `a device has at most one control lease`, `remote session mode, status and reason are constrained`, `closed session must have closed_at and reason`, `remote session device belongs to the lesson site`, `fencing values increase`.
- [ ] **Step 2:** → FAIL. **Step 3:** Sxema + `drizzle-kit generate`. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): remote sessions and control lease schema`.

### Task 5: Outbox — tashqi handler'lar tranzaksiyadan tashqarida

ADR 0006 cheklovi: handler'lar claim tranzaksiyasi ichida ishlaydi. `remote.revoke` MeshCentral'ga boradi, shuning uchun claim va bajarish ajratiladi.

**Files:**
- Modify: `apps/api/src/modules/workers/outbox.worker.ts`, `apps/api/src/modules/events/event-log.ts` (`OutboxPayload` ga `sessionId?: string`; topic union'ga `'remote.revoke'`)
- Test: `apps/api/test/outbox.test.ts`, `apps/api/test/concurrency.pg.test.ts`

**Interfaces:**
- Produces: `OutboxWorker.tick(now)` o'zgarmaydi (qaytgan son). `OutboxWorker.kick(): void` — keyingi tick'ni darhol rejalashtiradi (`workers: false`da no-op).
- Algoritm: tranzaksiya 1 — due qatorlar `FOR UPDATE SKIP LOCKED`, har biriga `next_attempt_at = now + 30 s` (claim lease) va commit; keyin handler'lar tranzaksiyasiz; natija — alohida `UPDATE … WHERE id = $id AND processed_at IS NULL` (muvaffaqiyat → `processed_at`; xato → mavjud backoff/park qoidalari). Jarayon claim'dan keyin o'lsa qator 30 s'dan keyin qayta olinadi (at-least-once; handler'lar idempotent).

- [ ] **Step 1: Failing testlar:** mavjud 4 test yashil qoladi + `a crashed claim is retried after the claim lease` (handler hech qachon resolve bo'lmaydi → `tick(now + 30_001)` qatorni qayta oladi, `tick(now + 29_000)` olmaydi), `kick runs a tick without waiting for the interval`; `concurrency.pg.test.ts` (real PostgreSQL): `outbox handlers run outside the claim transaction` (handler boshqa pool ulanishidan shu qatorni `SELECT … FOR UPDATE NOWAIT` bilan oladi — claim tranzaksiyasi ochiq bo'lsa `55P03` bilan yiqiladi).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `refactor(api): run outbox handlers outside the claim transaction`.

### Task 6: Gateway API jarayonida, config va ilova ulanishi

**Files:**
- Create: `apps/api/src/modules/remote-sessions/{remote-gateway.ts,remote-sessions.module.ts}`
- Modify: `apps/api/src/config/config.ts`, `apps/api/src/main.ts`, `apps/api/src/app.ts` (`CreateAppOptions.remote`), `apps/api/test/support/app.ts` (fake upstream), `apps/api/package.json` (`@netschool/session-gateway`, `@netschool/meshcentral-adapter` workspace), `apps/api/src/common/errors.ts` (`control_busy` → 409)
- Test: `apps/api/test/config.test.ts`, `apps/api/test/remote-gateway.test.ts`

**Interfaces:**
- Produces:

```typescript
// config.ts
ApiConfig.gateway: { port: number; publicOrigin: string } | null; // mesh null bo'lsa null
// remote-gateway.ts
export interface RemoteUpstream {
  viewer: ViewerUpstream; // @netschool/session-gateway
  listPrincipals(): Promise<{ userId: string; sessionId: string }[]>;
  revokePrincipal(userId: string): Promise<void>;
}
export const REMOTE_GATEWAY: symbol;
@Injectable() export class RemoteGateway {
  readonly enabled: boolean; // upstream va config.gateway bor
  open(req: AuthorizedDesktopRequest): Promise<void>; // broker.open; ticket'ni tashlab yuboradi
  issueTicket(sessionId: string): { url: string; expiresAt: number }; // registry'da ochiq bo'lmasa Error
  close(sessionId: string): Promise<void>; // broker.close
  isOpen(sessionId: string): boolean;
  listen(port: number, host: string): Promise<number>;
  stop(): Promise<void>; // onModuleDestroy
}
// app.ts
CreateAppOptions.remote?: RemoteUpstream | null;
```
- `main.ts`: `config.mesh` bo'lsa `RemoteUpstream` = `MeshCentralViewerUpstream({ admin: mesh, endpoint: { origin: https://<MESHCENTRAL_URL host:port>, ca }, publicHost: new URL(gateway.publicOrigin).host })` + `MeshCentralPrincipals(mesh)`; `app.listen`dan keyin `app.get(RemoteGateway).listen(config.gateway.port, config.host)`. Gateway TLS — API bilan bir xil cert/key. Gateway `onEvent` → Nest `Logger` (`route_denied`, `frame_dropped`, `ticket_rejected` — `warn`; `upstream_error` — `error`); sir yoki ticket logga tushmaydi.
- Config qoidalari: `GATEWAY_PUBLIC_ORIGIN` — `PUBLIC_ORIGIN` bilan bir xil sxema (bare https origin); `MESHCENTRAL_URL` bor, `GATEWAY_PUBLIC_ORIGIN` yo'q → xato; `GATEWAY_PORT` port raqami va `API_PORT`dan farqli.

- [ ] **Step 1: Failing testlar:** config — `gateway requires a public origin when MeshCentral is configured`, `gateway port must differ from the API port`, `no gateway without MeshCentral`. remote-gateway (fake `ViewerUpstream`, listener `127.0.0.1:0`) — `issued ticket redeems once to the viewer entry` (303 → `entryPath`, `__Host-ns_rs` cookie; ikkinchi redeem rad), `closing terminates the session` (`isOpen` false, fake `revoke` chaqirildi), `disabled gateway reports not enabled`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm typecheck`, `pnpm build:api` → 0.
- [ ] **Step 5:** Commit `feat(api): host the remote session gateway in the API process`.

### Task 7: Sessiya ochish, control lease va ticket

**Files:**
- Create: `apps/api/src/modules/remote-sessions/{remote-sessions.service.ts,remote-sessions.controller.ts,closing.ts}`
- Modify: `apps/api/src/modules/remote-sessions/remote-sessions.module.ts`, `apps/api/src/app.ts`
- Test: `apps/api/test/remote-sessions.test.ts`, `apps/api/test/concurrency.pg.test.ts`

**Interfaces:**
- Consumes: Task 1 action'lar, Task 4 jadvallar, Task 6 `RemoteGateway`, P1c `Idempotency`, `EventLog`, `Outbox`, P1b mesh binding va `requirePort`/`upstream()` (`listDevices(siteId)` → `agentOnline`).
- Produces:

```typescript
// closing.ts — modul DI'siz (LessonsService, DevicesService, maintenance chaqiradi)
export type SessionFilter = { lessonId: string } | { deviceId: string } | { sessionId: string } | { expiredAt: Date };
export async function closeRemoteSessions(tx: Db, filter: SessionFilter, reason: CloseReason,
  at: Date, closedBy: string | null, deps: { events: EventLog; outbox: Outbox }): Promise<string[]>; // yopilgan id'lar
// remote-sessions.service.ts
open(ctx, lessonId, body, idempotencyKey): Promise<RemoteSession>;
issueTicket(ctx, sessionId): Promise<{ url: string; expiresAt: string }>;
view(db, sessionId): Promise<RemoteSession>; // Task 10 snapshot ham ishlatadi
```
- `closeRemoteSessions`: filter bo'yicha `status <> 'closed'` qatorlarni `FOR UPDATE` bilan oladi → `closed` (`closed_at`, `close_reason`, `closed_by`), `control_leases` qatorini o'chiradi, har biriga `remote_session.closed` event, `remote.revoke` outbox, `remote_session.close` audit.
- `POST /api/v1/lessons/{lessonId}/remote-sessions` → 201 `remoteSession`: avval replay — kalit saqlangan bo'lsa darvozasiz `view()` (P1c `CommandsService`dagi replay-first usuli, ADR 0006 "Takroriy so'rov oldindan"). So'ng Global Constraints'dagi darvoza **o'sha tartibda** tranzaksiyasiz o'qiladi (ruxsat → a'zolik → binding → capability → `agentOnline`; MeshCentral chaqiruvi tranzaksiyani ushlab turmasligi uchun, 403 esa offline/capability xatolaridan oldin); `Idempotency.run` ichida — dars `FOR SHARE` va a'zolik qayta tekshiriladi, `remote_sessions` insert (`opening`, `expires_at = now + 30 s`), `control` bo'lsa `INSERT … ON CONFLICT (device_id) DO UPDATE … WHERE control_leases.expires_at <= now RETURNING` (qator qaytmasa → 409 `control_busy`, tranzaksiya rollback); commit'dan keyin `RemoteGateway.open` → tranzaksiya: `UPDATE … SET status='active' WHERE id AND status='opening'` + event + audit; agar 0 qator (oraliqda yopilgan) → `RemoteGateway.close` darhol. Upstream xatosi → `closeRemoteSessions({sessionId}, 'upstream_failed')` + 503 `upstream_unavailable`. Replay (shu kalit) → `view()` (joriy holat); jarayon ichidagi bir sessiyaning parallel aktivatsiyasi bitta va'da orqali.
- `POST /api/v1/remote-sessions/{id}/ticket` → 200 `remoteTicket`, `cache-control: no-store`; faqat sessiya egasi; sessiya `active` va `RemoteGateway.isOpen` emas → 409 `conflict`.
- `GET /api/v1/remote-sessions/{id}` → `remoteSession` (egasi yoki `remote.manage`).

- [ ] **Step 1: Failing testlar** (fake `RemoteUpstream`; ochish/yopish va principal'lar yozib boriladi): `teacher opens a view session on a lesson device`, `devices outside the lesson are denied` (boshqa xona, boshqa teacher darsi, retired), `unbound or unconfigured devices are capability_unavailable`, `reported unavailable remote desktop is capability_unavailable`, `offline agent is device_offline`, `second controller gets control_busy` (view esa ochiladi), `expired lease can be taken and the old fencing is rejected` (Task 8 renew bilan), `upstream failure releases the lease` (keyin boshqa teacher control ola oladi), `lesson ending during open revokes the fresh principal` (fake `viewer.open` ichida `endLesson` chaqiriladi → yakuniy holat `closed/lesson_ended`, fake revoke chaqirilgan, ticket 409), `retried open creates one session and never stores a ticket` (`idempotency_keys.response_body`da `ticket` va `/rs/redeem` yo'q), `ticket is issued only to the session owner`, `ticket for a closed session conflicts`. pg: `control lease is exclusive under concurrency` (`Promise.all` 5 ta control → 1 ta 201, 4 ta 409 `control_busy`).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): open remote sessions with an exclusive control lease`.

### Task 8: Renew, yopish va yopilish sabablari

**Files:**
- Modify: `apps/api/src/modules/remote-sessions/{remote-sessions.service.ts,remote-sessions.controller.ts,remote-sessions.module.ts}`, `apps/api/src/modules/lessons/lessons.service.ts` (`endLesson`), `apps/api/src/modules/devices/devices.service.ts` (`#leaveLesson`), `apps/api/src/modules/workers/maintenance.worker.ts`, `apps/api/src/modules/workers/outbox.worker.ts` (`remote.revoke` handler)
- Test: `apps/api/test/remote-sessions-lifecycle.test.ts`, `apps/api/test/maintenance.test.ts`

**Interfaces:**
- Consumes: Task 7 `closeRemoteSessions`, Task 5 `kick()`, Task 6 `RemoteGateway.close`.
- Produces:
  - `POST /api/v1/remote-sessions/{id}/renew` → 200 `remoteSession`: faqat egasi; bitta tranzaksiyada `remote_sessions.expires_at = now + 30 s WHERE status='active' AND expires_at > now`; `control` — `control_leases.expires_at` ham, `WHERE session_id AND fencing = $fencing AND expires_at > now`. Har ikkala update 1 qator bo'lmasa → 409 `conflict` (hech narsa uzaymaydi).
  - `DELETE /api/v1/remote-sessions/{id}` → 204: egasi (`teacher`) yoki `remote.manage` (`admin`); allaqachon yopiq → 204 o'zgarishsiz.
  - `endLesson` → `closeRemoteSessions({lessonId}, 'lesson_ended')`; `#leaveLesson` → `({deviceId}, 'device_left')`; maintenance tick → `({expiredAt: now}, 'lease_expired')` va `tick` natijasiga `expiredSessions: number`.
  - Outbox `remote.revoke` handler → `RemoteGateway.close(sessionId)`; gateway o'chiq (`enabled === false`) → no-op. Yopilish tranzaksiyasi commit'idan keyin chaqiruvchi `kick()` qiladi.

- [ ] **Step 1: Failing testlar:** `renew extends the session and the lease`, `renew with a stale fencing conflicts`, `renew after expiry conflicts`, `owner closes the session and sockets are closed` (fake `close` chaqirildi, `tick` bilan), `admin closes another teacher's session`, `other teacher cannot close`, `ending the lesson closes its remote sessions`, `moving a device out of the room closes its sessions`, `unrenewed session expires and frees the device` (maintenance `tick(now + 30_001)` → `lease_expired`, keyin boshqa teacher control oladi), `failed revoke is retried` (fake `close` birinchi marta throw → keyingi tick'da yana chaqiriladi), `revoke happens within two seconds of closing` (`workers: true`, haqiqiy taymer bilan, fake `close` ≤ 2000 ms).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): renew, close and revoke remote sessions`.

### Task 9: Startup va davriy reconciliation

**Files:**
- Create: `apps/api/src/modules/remote-sessions/reconciler.ts`
- Modify: `apps/api/src/modules/remote-sessions/remote-sessions.module.ts`
- Test: `apps/api/test/remote-reconcile.test.ts`

**Interfaces:**
- Consumes: Task 6 `RemoteUpstream.listPrincipals/revokePrincipal`, Task 7 `closeRemoteSessions`.
- Produces: `RemoteReconciler.reconcile(now: number, opts: { startup: boolean }): Promise<{ closedSessions: number; deletedPrincipals: number }>`.
  - `startup: true`: `status <> 'closed'` hammasi → `restart` (gateway xotirasi bo'sh — hech biri tirik emas); keyin `listPrincipals()` dagi hammasi `revokePrincipal`.
  - `startup: false` (har 5 daqiqa, `workers: true`): faqat `sessionId`si DB'da `closed` yoki DB'da yo'q principal'lar o'chiriladi; `active` sessiya principal'iga tegilmaydi.
  - MeshCentral ulanmagan bo'lsa (adapter `upstream_unavailable`) — DB qismi bajariladi, principal qismi keyingi davrda (log `warn`). `workers: true` bo'lsa startup reconcile `onApplicationBootstrap`da, gateway `listen`dan **oldin**.

- [ ] **Step 1: Failing testlar:** `startup closes stale sessions and deletes orphan principals` (2 ochiq sessiya, 3 principal → hammasi), `periodic pass keeps principals of active sessions`, `periodic pass deletes principals of closed or unknown sessions`, `unreachable MeshCentral still closes sessions in the database`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(api): reconcile remote sessions and principals`.

### Task 10: Events snapshot

**Files:**
- Modify: `apps/api/src/modules/events/events.service.ts`
- Test: `apps/api/test/events.test.ts`

**Interfaces:**
- Consumes: Task 7 `RemoteSessionsService.view`.
- Produces: snapshot `remoteSessions` — faol darsning `status <> 'closed'` sessiyalari (`opened_at` bo'yicha); `remote_session.opened|closed` eventlari xona oqimida (Task 7–8 yozadi).

- [ ] **Step 1: Failing testlar:** `snapshot lists open remote sessions of the active lesson`, `remote session open and close appear in the room stream`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(api): remote sessions in room events`.

### Task 11: E2E contract — real MeshCentral bilan API + gateway

**Files:**
- Create: `tests/contracts/remote-sessions.test.ts`, `tests/contracts/harness/api.ts`
- Test: o'zi

**Interfaces:**
- Consumes: `startMeshCentral()` (harness), `createApp` (PGlite, `workers: true`), Task 6 ulanishi (main.ts'dagi kabi `RemoteUpstream`), P0b `viewer-browser`/`gateway` testlaridagi WS yordamchilari.
- `tests/contracts/harness/api.ts`: `startApi(mc: MeshCentralInstance): Promise<{ baseUrl, gatewayOrigin, ca, login(user), seedLessonWithBoundDevice(): {...}, close() }>` — mesh binding'ni DB'ga to'g'ridan-to'g'ri yozadi (haqiqiy agent yo'q; `agentOnline` tekshiruvi uchun fake node P0b harness'idagidek).

- [ ] **Step 1: Failing testlar:** `control session opens through the API and the gateway` (open → ticket → redeem 303 → gateway orqali `control.ashx` WS ochiladi; MeshCentral'da `ns-sess-<id>` user bor), `ending the lesson closes viewer sockets within two seconds and deletes the principal`, `second teacher gets control_busy against real MeshCentral`, `restart reconciliation deletes leftover principals` (app yopiladi, principal qoldiriladi, yangi app startup'dan keyin yo'q).
- [ ] **Step 2:** `pnpm test:contract -t "remote sessions"` → FAIL.
- [ ] **Step 3:** Implement harness. **Step 4:** → PASS; butun `pnpm test:contract` yashil.
- [ ] **Step 5:** Commit `test(contracts): remote sessions end to end against MeshCentral`.

### Task 12: Compose — MeshCentral ulanishi va gateway porti

**Files:**
- Create: `infra/meshcentral/entrypoint.sh`
- Modify: `infra/meshcentral/Dockerfile`, `infra/meshcentral/render-config.mjs` (`trustedProxy: 'api'`), `infra/meshcentral/README.md`, `infra/compose/compose.yaml`, `infra/compose/.env.example`, `infra/compose/README.md`, `.github/workflows/ci.yml` (compose-smoke), `apps/api/src/modules/health/health.controller.ts`
- Test: `infra/compose/test/compose.test.ts`, `apps/api/test/health.test.ts`, CI `compose-smoke`

**Interfaces:**
- Produces:
  - `entrypoint.sh`: config render → secret `meshcentral_service_password` bo'yicha service account (`netschool-svc`) yo'q bo'lsa `--createaccount … --pass=…` va `--adminaccount` (MeshCentral to'xtagan holatda, asosiy jarayondan oldin; mavjud bo'lsa o'tkazib yuboriladi) → `root-cert-public.crt` paydo bo'lgach (≤120 s) uni `meshcentral-ca` volume'ga (faqat public cert) nusxalaydi → `exec node meshcentral.js`. Private key'lar api konteyneriga mount qilinmaydi.
  - compose: `meshcentral` healthcheck — CA fayli bor va 4430 TLS javob beradi; `api` `depends_on` meshcentral healthy; env `MESHCENTRAL_URL=wss://meshcentral:4430/control.ashx`, `MESHCENTRAL_USERNAME=netschool-svc`, `MESHCENTRAL_PASSWORD_FILE`, `MESHCENTRAL_CA_FILE=/run/meshcentral-ca/root-cert-public.crt`, `GATEWAY_PUBLIC_ORIGIN=${GATEWAY_PUBLIC_ORIGIN:?}`; port `8444:8444`. MeshCentral portlari hamon publish qilinmaydi. `trustedProxy: 'api'` — MeshCentral bitta satrli qiymatni DNS orqali IP'ga aylantiradi (webserver.js:7216-7217).
  - `GET /api/v1/healthz` → `{ status, db, mesh: 'ok' | 'down' | 'disabled' }` (mesh `down` bo'lsa ham HTTP 200 — API MeshCentral'siz ishlaydi).

- [ ] **Step 1: Failing testlar:** compose — `api publishes only 443 and the gateway port`, `meshcentral private data is not mounted into api`, `api waits for a healthy meshcentral`; health — `health reports mesh state`. CI compose-smoke: healthz `mesh` `"ok"` bo'lishini kutadi.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS lokal; push'dan keyin CI `compose-smoke` yashil.
- [ ] **Step 5:** Commit `feat(infra): connect the hub API to MeshCentral and publish the gateway`.

### Task 13: Hujjatlar

**Files:**
- Create: `docs/adr/0008-remote-sessions.md`
- Modify: `docs/superpowers/plans/2026-10-27-netschool-roadmap.md` (P1d holati), `docs/adr/0003-session-gateway.md` ("Ma'lum cheklovlar"dagi P1d bandlari hal bo'lganini belgilash)

- [ ] **Step 1:** ADR 0008: gateway API jarayonida (nega alohida servis emas; bir host/boshqa port — same-site, alohida origin); sessiya holatlari va yopilish sabablari; ochish darvozasi tartibi va nega `agentOnline` tranzaksiyadan oldin; control lease (30 s/10 s, `ON CONFLICT … WHERE expires_at <= now`, fencing va eskirgan renew); ticket DB/idempotency'da saqlanmaydi, alohida endpoint (reload → yangi ticket); revoke outbox orqali (tranzaksiyadan tashqarida, ≤2 s); reconciliation (startup — hammasi, davriy — faqat yopilganlar; `ns-sess-` prefiksi); compose (service account, faqat public CA ulashiladi, `trustedProxy: 'api'`); P1d'da yo'q (control'ni majburan olib qo'yish/takeover, it_support uchun darsdan tashqari sessiya, gateway hodisalarini auditga yozish — hozir log, bir nechta API replikasi, P1f iframe/framing, P0c'ga qolgan real agent tekshiruvlari).
- [ ] **Step 2:** `pnpm lint` → 0. **Step 3:** Commit `docs: record remote session decisions`.
