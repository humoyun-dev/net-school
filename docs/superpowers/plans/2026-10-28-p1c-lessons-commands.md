# P1c — Lessons, commands, outbox, events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teacher xonada dars ochadi va yopadi; darsdagi qurilmalarga typed buyruq (xabar, soft overlay lock/unlock) yuboradi va har qurilma natijasini ko'radi; qurilma buyruqni tez oladi va natijani tasdiqlaydi; overlay server bilan aloqa uzilsa o'zi tushadi; panel holatni `snapshot + cursor` bilan oladi; mutatsiyalar `Idempotency-Key` bilan takrorlanmaydi.

**Architecture:** Yangi `apps/api/src/modules/{lessons,commands,events,workers}` va umumiy `common/idempotency.ts`. Har mutatsiya, uning audit yozuvi, `events` qatori va `outbox` qatori bitta tranzaksiyada. Outbox worker tashqi effektlarni (hozircha qurilma/xona long-poll'larini uyg'otish) qayta urinish bilan bajaradi; maintenance worker muddati o'tgan target'larni `expired` qiladi, vaqti tugagan darslarni yopadi va eski yozuvlarni tozalaydi. Qurilma kanali P1b imzolangan so'rovlari ustida: long-poll `GET /device/commands` va receipt; heartbeat javobi dars va overlay lease'ini qaytaradi. Ruxsat va buyruq holat mashinasi `packages/domain`da sof funksiyalar.

**Tech Stack:** P1a/P1b bilan bir xil (NestJS 11, Drizzle 0.45, zod 4, PGlite/PostgreSQL 17); yangi dependency yo'q.

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md) §8 (Lessons, Commands; invariantlar), §9 (endpointlar, `Idempotency-Key`, `202`, command envelope va lifecycle), §10 (overlay lease, eskirgan lock replay qilinmaydi), §11 (buyruq oqimi media'dan alohida; ack p95 ≤1 s maqsadi), §15.1 (qabul). Yo'l xaritasi: [2026-10-27-netschool-roadmap.md](2026-10-27-netschool-roadmap.md) (P1c). Oldingi qarorlar: [ADR 0004](../../adr/0004-school-hub-api.md), [ADR 0005](../../adr/0005-devices-enrollment.md).

## Global Constraints

- P1a/P1b Global Constraints amal qiladi (xato konverti, correlation ID, audit bitta tranzaksiyada, begona/noma'lum ID → bir xil audit qilingan 403, `@Inject` tokenlar, zod, kod inglizcha, docs o'zbekcha).
- Bitta xonada bitta `active` dars: partial unique `lessons(room_id) where status = 'active'`. Bitta qurilmada bitta faol dars biriktirmasi: partial unique `lesson_devices(device_id) where released_at is null`.
- Dars davomiyligi `durationMinutes` 5…480, default 90 → `scheduled_end_at`; vaqt o'tsa maintenance worker `end_reason = 'timeout'` bilan yopadi. `end_reason`: `teacher` | `admin` | `timeout`.
- Buyruq turlari (P1c): `message.show` `{ text: 1..500 }` (capability `classroom.message`), `overlay.lock` `{ message?: 0..200 }` va `overlay.unlock` `{}` (capability `classroom.overlay`). Boshqa tur 400. Arbitrary shell yo'q.
- Buyruq TTL `ttlSeconds` 10…600, default 60 → `expires_at`. Target holatlari: `pending → sent → acknowledged → succeeded | failed | expired | cancelled`; `failed` sababi `unsupported` | `permission_required` | `error`. Terminal holatdan chiqish yo'q; bir xil terminal receipt qayta kelsa no-op.
- Capability darvozasi target bo'yicha: capability `available` → `pending`; `requires_permission` → `failed/permission_required`; boshqa holat yoki hisobot yo'q → `failed/unsupported`. Hech bir target `pending` bo'lmasa → 409 `capability_unavailable`, hech narsa yozilmaydi. Barcha `pending` target'lar presence `online` emas → 503 `device_offline`, hech narsa yozilmaydi. Aks holda 202, offline target'lar TTL ichida `pending` kutadi.
- Command envelope (qurilmaga): `{ commandId, sequence, targetDeviceId, lessonId, issuedAt, expiresAt, type, payload }`; `sequence` = `commands.seq` (global monoton bigint, string sifatida). Qurilma kichikroq `sequence`ni e'tiborsiz qoldiradi.
- Overlay lease: heartbeat javobi `lesson: { id, overlay: { locked, sequence, leaseExpiresAt } } | null`, `leaseExpiresAt = now + 120 s`. Dars tugagan yoki qurilma darsda bo'lmasa `lesson: null`.
- Long-poll: `wait` 0…25 soniya (default 0); in-process notifier, timeout'da bo'sh javob.
- `Idempotency-Key` header (`^[A-Za-z0-9_-]{8,128}$`) majburiy: `POST /rooms/{roomId}/lessons`, `POST /lessons/{id}/end`, `POST /lessons/{id}/commands`. Yo'q/noto'g'ri → 400. Kalit actor + marshrut doirasida 24 soat saqlanadi; bir xil so'rov → saqlangan status va body qaytadi (yangi yozuv yo'q); boshqa body bilan → 409 `conflict`; xato bilan tugagan so'rov saqlanmaydi.
- Events: `events.seq` bigint, cursor string. `GET /api/v1/events?roomId=&after=&wait=`; `after` yo'q yoki saqlanganidan eski → `resync: true` + snapshot. Event turlari: `lesson.started`, `lesson.ended`, `command.created`, `command.target_updated`. Media/heartbeat event emas.
- Yangi audit action'lar: `lesson.start`, `lesson.end`, `command.issue` (details: `type`, target soni; matn yo'q). Receipt'lar audit emas, `command_receipts`da.
- Retention (maintenance): `idempotency_keys` 24 soat, processed `outbox` 1 kun, `events` 7 kun.
- Workerlar `createApp`ning `workers` opsiyasi bilan (prod: `true`, testlar: `false` va `tick(now)` qo'lda). Notifier va workerlar bitta API jarayoni uchun (ADR'da cheklov).
- `409 control_busy` P1d'da (control lease bilan); P1c'da ishlatilmaydi.

## Review Focus

1. **Takroriy buyruq** — tarmoq qayta urinishi bir xil `Idempotency-Key` bilan → bitta buyruq va bitta target to'plami; parallel bir xil kalit → bitta; boshqa body bilan shu kalit → 409. → Task 4 `same key replays the stored response`, `concurrent requests with one key run once`, Task 6 `retried command is created once`.
2. **Eskirgan lock qaytmasligi** — dars tugagach yoki qurilma qayta ulanganda heartbeat `lesson: null`; muddati o'tgan buyruq pull'da kelmaydi; overlay lease hech qachon server vaqtidan 120 s'dan uzoq emas. → Task 7 `ended lesson releases overlay on next heartbeat`, `expired commands are never delivered`.
3. **Dars tugashi bilan poyga** — tugagan darsga buyruq → 409; tugash non-terminal target'larni `cancelled` qiladi; bekor/eskirgan target'ga kech receipt → 409 va holat o'zgarmaydi. → Task 5 `ending a lesson cancels open targets`, Task 7 `late receipt does not revive a cancelled target`.
4. **Begona qurilma/dars** — teacher darsda yo'q, boshqa xonadagi yoki boshqa teacher darsidagi qurilmani nishonlasa → 403 audit bilan; ikki teacher bir xonada parallel dars ochsa → bittasi. → Task 6 `targets outside the lesson are denied`, Task 5 `one active lesson per room under concurrency`.
5. **Aralash natija** — 30 target, bir qismi capability'siz/offline → target bo'yicha holat, umumiy "success" yo'q; hammasi offline → 503; hech biri qodir emas → 409. → Task 6 `mixed fleet yields per-target results`.

---

### Task 0: Branch

- [x] **Step 1:** Stacked: `git switch p1b-devices-enrollment && git switch -c p1c-lessons-commands` (bajarilgan).

### Task 1: Domain — dars/buyruq ruxsatlari, holat mashinasi, capability darvozasi

**Files:**
- Modify: `packages/domain/src/access/authorize.ts`
- Create: `packages/domain/src/commands.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/authorize.test.ts`, `packages/domain/test/commands.test.ts`

**Interfaces:**
- Produces:

```typescript
// authorize.ts
Action += 'lesson.start' | 'lesson.read' | 'lesson.end' | 'command.issue' | 'command.read';
Target += { ownerUserId?: string }; // dars egasi (teacher)
// commands.ts
export type CommandType = 'message.show' | 'overlay.lock' | 'overlay.unlock';
export const COMMAND_CAPABILITY: Record<CommandType, string>; // 'classroom.message' | 'classroom.overlay'
export type TargetStatus = 'pending' | 'sent' | 'acknowledged' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
export type FailureReason = 'unsupported' | 'permission_required' | 'error';
export const TERMINAL: ReadonlySet<TargetStatus>;
export type Gate = { status: 'pending' } | { status: 'failed'; reason: 'unsupported' | 'permission_required' };
export function gateTarget(type: CommandType, capabilities: Record<string, { state: string }> | null): Gate;
export type ReceiptStatus = 'acknowledged' | 'succeeded' | 'failed';
export type Transition = { kind: 'apply'; to: TargetStatus } | { kind: 'noop' } | { kind: 'reject' };
export function applyReceipt(current: TargetStatus, receipt: ReceiptStatus): Transition;
```
- Qoidalar: org admin — hammasi. Site school_admin — o'z site'ida hammasi (recovery). it_support — `lesson.read`, `command.read` o'z site'ida. teacher — `lesson.start`, `lesson.read`, `command.read` `roomId` o'z xonasida; `lesson.end`, `command.issue` faqat `roomId` o'z xonasida **va** `ownerUserId === actor.userId`. student — hech narsa.
- `applyReceipt`: `acknowledged` faqat `pending|sent`dan; `succeeded|failed` `pending|sent|acknowledged`dan; terminalda xuddi shu holat → `noop`, boshqasi → `reject`; `acknowledged` kelganda holat allaqachon `acknowledged` → `noop`.

- [ ] **Step 1: Failing testlar:** authorize jadvaliga yangi action'lar, `teacher ends and commands only own lesson`, `it_support reads lessons but cannot command`; `commands.test.ts`: `gate maps capability states`, `receipt transitions follow the lifecycle` (har juftlik jadvali), `terminal states never change`.
- [ ] **Step 2:** `pnpm vitest run packages/domain` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS; `pnpm typecheck` → 0.
- [ ] **Step 5:** Commit `feat(domain): lesson and command permissions, command lifecycle`.

### Task 2: Contracts

**Files:**
- Create: `packages/contracts/src/api/v1/{lessons.ts,commands.ts,events.ts}`
- Modify: `packages/contracts/src/api/v1/devices.ts` (heartbeat javobi), `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/commands.test.ts`

**Interfaces:**
- Produces: `idempotencyKeySchema`; `startLessonRequestSchema` `{ title?: 1..100 trim, durationMinutes?: int 5..480 }`; `lessonSchema` `{ id, siteId, roomId, teacherUserId, title|null, status: 'active'|'ended', startedAt, scheduledEndAt, endedAt|null, endReason|null, deviceIds: uuid[] }`; `issueCommandRequestSchema` — `type` bo'yicha discriminated union (`message.show` `{ text }`, `overlay.lock` `{ message? }`, `overlay.unlock` `{}`, payload strict) + `targetDeviceIds?: uuid[] 1..200 unique` + `ttlSeconds?: int 10..600`; `commandSchema` `{ id, lessonId, type, sequence: string, issuedAt, expiresAt, targets: { deviceId, status, reason|null, updatedAt }[], summary: Record<TargetStatus, number> }`; `deviceCommandSchema` (envelope, Global Constraints); `deviceCommandsResponseSchema` `{ commands }`; `receiptRequestSchema` `{ status: 'acknowledged'|'succeeded'|'failed', reason?: FailureReason }` (`failed` bo'lsa `reason` majburiy, aks holda taqiqlangan); `heartbeatResponseSchema` ga `lesson` (Global Constraints); `eventSchema` `{ seq: string, type, at, lessonId|null, data: record }`; `eventsResponseSchema` `{ cursor: string, resync: boolean, snapshot?: { lesson: lessonSchema|null, commands: commandSchema[] }, events }`.

- [ ] **Step 1: Failing testlar:** `command payload must match its type`, `unknown command type is rejected`, `failed receipt requires a reason and others forbid it`, `duplicate target ids are rejected`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(contracts): lesson, command and event schemas`.

### Task 3: DB sxema

**Files:**
- Modify: `apps/api/src/db/schema.ts`, `apps/api/test/support/db.ts` (`TABLES`)
- Create: `apps/api/drizzle/0005_*.sql` (+ kerak bo'lsa keyingi raqam — FK o'z unique'idan oldin chiqsa P1b'dagidek ikkiga bo'linadi)
- Test: `apps/api/test/db-invariants.test.ts`

**Interfaces:**
- Produces:
  - `lessons`: `id`, `organization_id`, `site_id`, `room_id`, `teacher_user_id`, `title null`, `status` (check `active|ended`), `started_at`, `scheduled_end_at`, `ended_at null`, `end_reason null` (check), `ended_by uuid null`; FK `(site_id, room_id)`→rooms(site_id,id), `(organization_id, teacher_user_id)`→users; partial unique `lessons_room_active (room_id) where status='active'`; unique `(organization_id, id)`, `(site_id, id)`; check `status='ended' ⇔ ended_at is not null`.
  - `lesson_devices`: `lesson_id`, `device_id`, `organization_id`, `site_id`, `overlay_locked bool default false`, `overlay_seq bigint null`, `joined_at`, `released_at null`; PK `(lesson_id, device_id)`; FK `(site_id, lesson_id)`→lessons(site_id,id), `(site_id, device_id)`→devices(site_id,id); partial unique `(device_id) where released_at is null`.
  - `commands`: `id`, `seq bigint generated always as identity unique`, `organization_id`, `site_id`, `lesson_id`, `issued_by`, `type` (check), `payload jsonb`, `issued_at`, `expires_at`; FK `(site_id, lesson_id)`→lessons.
  - `command_targets`: `command_id`, `device_id`, `organization_id`, `status` (check 7 holat), `reason null` (check), `updated_at`, `sent_at null`, `acknowledged_at null`, `finished_at null`; PK `(command_id, device_id)`; FK `command_id`→commands cascade, `(organization_id, device_id)`→devices(organization_id,id); index `(device_id, status)` va expiry uchun `(status, …)` (`commands.expires_at` join bilan).
  - `command_receipts`: `id`, `command_id`, `device_id`, `status`, `reason null`, `received_at`; FK `(command_id, device_id)`→command_targets cascade.
  - `events`: `seq bigint identity primary key`, `organization_id`, `site_id`, `room_id`, `lesson_id null`, `type`, `data jsonb`, `at`; index `(room_id, seq)`.
  - `outbox`: `id bigint identity primary key`, `organization_id`, `topic`, `payload jsonb`, `created_at`, `attempts int default 0`, `next_attempt_at`, `processed_at null`, `last_error text null`; partial index `(next_attempt_at) where processed_at is null`.
  - `idempotency_keys`: `actor_user_id`, `scope text`, `key text`, `request_hash text`, `response_status int`, `response_body jsonb`, `created_at`; PK `(actor_user_id, scope, key)`.

- [ ] **Step 1: Failing testlar:** `one active lesson per room`, `a device is in one active lesson`, `lesson devices belong to the lesson site`, `command target status and reason are constrained`, `ended lesson must have ended_at`.
- [ ] **Step 2:** → FAIL. **Step 3:** Sxema + `drizzle-kit generate` (generated SQL qo'lda tahrirlanmaydi). **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): lessons, commands, events, outbox and idempotency schema`.

### Task 4: Idempotency

**Files:**
- Create: `apps/api/src/common/idempotency.ts`
- Test: `apps/api/test/idempotency.test.ts` (test-only controller)

**Interfaces:**
- Produces:

```typescript
export function idempotencyKeyOf(req: Request): string; // header yo'q/noto'g'ri → ApiError('validation_failed')
@Injectable() export class Idempotency {
  // Kalit qatori ish bilan bitta tranzaksiyada: commit bo'lmasa kalit saqlanmaydi.
  run<T>(ctx: RequestContext, scope: string, key: string, request: unknown, status: number,
         work: (tx: Db) => Promise<T>): Promise<{ status: number; body: T }>;
}
```
- Algoritm: `request_hash` = SHA-256(kanonik JSON). Tranzaksiya ichida birinchi statement — kalit qatorini (bo'sh javob bilan) insert; keyin `work(tx)`; keyin javobni yozish. Insert unique buzilishi (boshqa tranzaksiya commit qilgan) → tranzaksiyadan tashqarida qatorni o'qish: hash teng → saqlangan `{status, body}`; farqli → 409 `conflict`. 24 soatdan eski qator mavjud deb hisoblanmaydi (o'chiriladi va qayta ishlanadi).
- Controller'lar `@Res({ passthrough: true })` bilan qaytgan `status`ni o'rnatadi.

- [ ] **Step 1: Failing testlar:** `missing or malformed key is rejected`, `same key replays the stored response` (ish 1 marta), `same key with a different body conflicts`, `failed work is not stored and can be retried`, `concurrent requests with one key run once`, `keys are scoped per actor and route`, `keys expire after 24 hours`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(api): Idempotency-Key for business mutations`.

### Task 5: Darslar

**Files:**
- Create: `apps/api/src/modules/lessons/{lessons.service.ts,lessons.controller.ts,lessons.module.ts}`, `apps/api/src/modules/events/{event-log.ts,events.module.ts}` (`@Global`: `EventLog`, `Outbox`; Task 7 notifier'larni, Task 10 controller'ni shu modulga qo'shadi)
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/lessons.test.ts`

**Interfaces:**
- Consumes: Task 1 action'lar, Task 4 `Idempotency`.
- Produces:
  - `EventLog.append(tx, e: { organizationId, siteId, roomId, lessonId: string|null, type, data }): Promise<void>` va `Outbox.enqueue(tx, topic: 'notify.devices'|'notify.rooms', payload: { deviceIds?: string[]; roomIds?: string[] }, now)` (`apps/api/src/modules/events/event-log.ts`, Task 8–10 ishlatadi).
  - `LessonsService.endLesson(tx, lessonId, reason, endedBy: string|null, correlationId)` — Task 9 (timeout) ham chaqiradi.
  - `POST /api/v1/rooms/{roomId}/lessons` → 201 `lesson`: room'dagi retired bo'lmagan qurilmalar `lesson_devices`ga; boshqa faol darsda turgan qurilma o'tkazib yuboriladi. Xonada faol dars bor → 409 `conflict` (parallelda ham). `GET /api/v1/rooms/{roomId}/lessons/active` → `{ lesson: lesson|null }`. `GET /api/v1/lessons/{id}`. `POST /api/v1/lessons/{id}/end` → 200 `lesson`; allaqachon tugagan → 409.
  - Tugash bir tranzaksiyada: `status='ended'`, `lesson_devices.released_at`, non-terminal target'lar `cancelled` (`finished_at`), `lesson.ended` event, `notify.devices` + `notify.rooms` outbox, audit.

- [ ] **Step 1: Failing testlar:** `teacher starts a lesson in an assigned room`, `teacher cannot start in another room`, `one active lesson per room under concurrency` (`Promise.all` ikki teacher), `only the owner or an admin ends a lesson` (boshqa teacher 403 audit), `ending a lesson cancels open targets` (commands jadvaliga to'g'ridan-to'g'ri qator bilan), `start and end are idempotent with the same key`, `lesson start and end append events and audit`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): lesson lifecycle with one active lesson per room`.

### Task 6: Buyruq berish va holati

**Files:**
- Create: `apps/api/src/modules/commands/{commands.service.ts,commands.controller.ts,commands.module.ts}`
- Test: `apps/api/test/commands.test.ts`

**Interfaces:**
- Consumes: Task 1 `gateTarget`, `COMMAND_CAPABILITY`; Task 4; Task 5 `EventLog`, `Outbox`.
- Produces: `POST /api/v1/lessons/{id}/commands` → 202 `command`; `GET /api/v1/commands/{id}` → `command` (`command.read`). `CommandsService.view(db, commandId): Promise<Command>` (Task 10 snapshot uchun).
- Tartib (bitta tranzaksiya): dars `FOR SHARE` va `active` (aks holda 409 `conflict`); target'lar default — darsning faol `lesson_devices`; berilgan target darsda bo'lmasa → 403 audit bilan; har target'ga `gateTarget` + presence (P1b `companionPresence`); Global Constraints'dagi 409/503 qoidalari; `commands` + `command_targets` insert; `overlay.lock|unlock` uchun `pending` target'larning `lesson_devices.overlay_locked/overlay_seq` yangilanadi; `command.created` event, `notify.devices` outbox (`pending` target'lar), audit.

- [ ] **Step 1: Failing testlar:** `teacher sends a message to the whole lesson`, `targets outside the lesson are denied` (boshqa xona qurilmasi, boshqa teacher darsi), `mixed fleet yields per-target results` (capable+online, capable+offline, `requires_permission`, hisobotsiz), `all offline targets is device_offline`, `no capable target is capability_unavailable`, `retried command is created once` (bir xil kalit), `command to an ended lesson conflicts`, `overlay lock records desired overlay state`, `command status is visible to the lesson owner only` (boshqa teacher 403).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(api): typed lesson commands with per-target results`.

### Task 7: Qurilma buyruq kanali va overlay lease

**Files:**
- Create: `apps/api/src/modules/commands/{device-commands.service.ts,device-commands.controller.ts}`, `apps/api/src/modules/events/notifier.ts`
- Modify: `apps/api/src/modules/events/events.module.ts` (`DEVICE_NOTIFIER`, `ROOM_NOTIFIER` provider/export)
- Modify: `apps/api/src/modules/devices/presence.service.ts` (heartbeat `lesson`)
- Test: `apps/api/test/device-commands.test.ts`

**Interfaces:**
- Consumes: P1b `DeviceAuthGuard`, Task 1 `applyReceipt`.
- Produces:

```typescript
// notifier.ts — in-process, kalit bo'yicha kutuvchilar
export class Notifier { wait(key: string, ms: number, signal?: AbortSignal): Promise<void>; wake(keys: Iterable<string>): void }
export const DEVICE_NOTIFIER: symbol; export const ROOM_NOTIFIER: symbol;
```
- `GET /api/v1/device/commands?wait=0..25` (imzolangan): shu qurilmaning `pending|sent` va `expires_at > now` target'lari, faol darsdagi; `pending` → `sent` (`sent_at`); bo'sh bo'lsa `wait` soniyagacha `DEVICE_NOTIFIER`da kutib bir marta qayta o'qiydi. Tartib `sequence` o'sish bo'yicha.
- `POST /api/v1/device/commands/{commandId}/receipt` (imzolangan) → 204; `applyReceipt` → `apply`: target yangilanadi (`*_at` ustunlari), `command_receipts` qatori, `command.target_updated` event, `notify.rooms`; `noop` → 204 o'zgarishsiz; `reject` yoki qurilmaga tegishli bo'lmagan target → 409 `conflict`. Holat o'zgarishi shartli `UPDATE … WHERE status = $current` bilan (maintenance bilan poyga).
- Heartbeat: qurilmaning faol `lesson_devices` qatori → `lesson: { id, overlay: { locked, sequence: overlay_seq|null, leaseExpiresAt: now+120s } }`, aks holda `null`.

- [ ] **Step 1: Failing testlar:** `device pulls pending commands and marks them sent`, `long poll returns when a command arrives` (`wait=5`, buyruq parallel beriladi), `long poll times out empty`, `receipts move a target through the lifecycle`, `late receipt does not revive a cancelled target`, `expired commands are never delivered`, `a device cannot report on another device's target`, `heartbeat carries the overlay lease while the lesson is active`, `ended lesson releases overlay on next heartbeat`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): device command channel with receipts and overlay lease`.

### Task 8: Outbox worker

**Files:**
- Create: `apps/api/src/modules/workers/{outbox.worker.ts,workers.module.ts}`
- Modify: `apps/api/src/app.ts` (`CreateAppOptions.workers?: boolean`), `apps/api/test/support/app.ts` (`workers: false`, `TestApp.get<T>(token)`)
- Test: `apps/api/test/outbox.test.ts`

**Interfaces:**
- Produces: `OutboxWorker.tick(now: number): Promise<number>` (qayta ishlangan qatorlar soni) — `SELECT … WHERE processed_at IS NULL AND next_attempt_at <= now ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, topic handler (`notify.devices` → `DEVICE_NOTIFIER.wake`, `notify.rooms` → `ROOM_NOTIFIER.wake`), muvaffaqiyat → `processed_at`; xato → `attempts+1`, `next_attempt_at = now + min(60 s, 1 s·2^attempts)`, `last_error` (xabar 200 belgigacha); 10 urinishdan keyin to'xtaydi (`processed_at` null qoladi, log `error`). Noma'lum topic → xato sifatida. `workers: true` bo'lsa har 250 ms va har outbox yozgan tranzaksiya commit'idan keyin `kick()`.

- [ ] **Step 1: Failing testlar:** `outbox rows wake waiting devices and rooms`, `failed handler retries with backoff`, `rows are processed once across concurrent ticks`, `unknown topic is retried then parked`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(api): outbox worker with retry and backoff`.

### Task 9: Maintenance worker

**Files:**
- Create: `apps/api/src/modules/workers/maintenance.worker.ts`
- Modify: `apps/api/src/modules/workers/workers.module.ts`
- Test: `apps/api/test/maintenance.test.ts`

**Interfaces:**
- Consumes: Task 5 `LessonsService.endLesson`.
- Produces: `MaintenanceWorker.tick(now: number): Promise<{ expiredTargets: number; endedLessons: number; purged: number }>` — `pending|sent|acknowledged` va `expires_at <= now` → `expired` (`command.target_updated` event + `notify.rooms`); `scheduled_end_at <= now` faol darslar → `endLesson(…, 'timeout', null, …)` (audit actor null); retention bo'yicha tozalash. `workers: true` bo'lsa har 1 s.

- [ ] **Step 1: Failing testlar:** `targets expire at their deadline`, `expiry does not override a terminal receipt` (poyga: receipt avval), `lessons end at their scheduled time and release overlay`, `old idempotency keys, outbox rows and events are purged`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(api): maintenance worker for expiry, lesson timeout and retention`.

### Task 10: Events API

**Files:**
- Create: `apps/api/src/modules/events/{events.service.ts,events.controller.ts}`
- Modify: `apps/api/src/modules/events/events.module.ts`
- Test: `apps/api/test/events.test.ts`

**Interfaces:**
- Consumes: Task 5 `EventLog`, Task 6 `CommandsService.view`, Task 7 `ROOM_NOTIFIER`.
- Produces: `GET /api/v1/events?roomId=<uuid>&after=<seq>&wait=0..25` (`lesson.read` xona bo'yicha): `after` yo'q yoki `after < min(seq)-1` (tozalangan) → `resync: true`, snapshot (faol dars va uning so'nggi 50 buyrug'i), `cursor` = xonadagi oxirgi seq (yo'q bo'lsa `"0"`); aks holda `after`dan keyingi eventlar (500 gacha), bo'sh bo'lsa `wait` bilan kutadi; `cursor` = oxirgi qaytgan seq yoki `after`. Faqat shu xona eventlari.

- [ ] **Step 1: Failing testlar:** `first call returns a snapshot and cursor`, `cursor returns only newer events of the room`, `purged cursor forces a resync`, `long poll wakes on a new event`, `teacher of another room is denied`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build:api` → 0.
- [ ] **Step 5:** Commit `feat(api): room events with snapshot and cursor`.

### Task 11: Hujjatlar

**Files:**
- Create: `docs/adr/0006-lessons-commands.md`
- Modify: `docs/superpowers/plans/2026-10-27-netschool-roadmap.md` (P1c holati)

- [ ] **Step 1:** ADR 0006: dars invariantlari va timeout; buyruq turlari, capability darvozasi, 202/409/503 qoidasi; target lifecycle va receipt; `sequence` va overlay lease (nega holat + buyruq birga); `Idempotency-Key` semantikasi; events (`snapshot + cursor`, long-poll — nega WS/SSE emas hozircha); outbox va maintenance; in-process notifier/workerlar cheklovi (bitta jarayon); P1c'da yo'q (control lease/`control_busy` — P1d; power buyruqlari MeshCentral orqali; help request/chat; Companion — P1e; guruhlar).
- [ ] **Step 2:** `pnpm lint` → 0. **Step 3:** Commit `docs: record lesson and command decisions`.
