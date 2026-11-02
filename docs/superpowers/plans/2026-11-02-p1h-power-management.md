# P1h — Markaziy quvvat boshqaruvi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IT admin markazdan kompyuterlarni o'chiradi, qayta yuklaydi, uxlatadi va (WoL qo'llasa) yoqadi. Ko'lam: tanlangan qurilmalar, xonalar, binolar (site) yoki butun universitet. Amal darhol, belgilangan vaqtda yoki haftalik jadval bilan bajariladi. Har qurilma natijasi alohida ko'rinadi. MeshCentral power buyrug'ining natijasini tasdiqlamaydi, shuning uchun natija qurilma holatini kuzatib aniqlanadi; aniqlanmasa `unknown`.

**Architecture:** Yangi API moduli `apps/api/src/modules/power/`. U P1c buyruq modeli naqshlarini qayta ishlatadi: har target uchun holat, `Idempotency-Key`, audit, `FOR UPDATE SKIP LOCKED` claim. Lekin u alohida jadvallarda turadi, chunki `commands` darsga bog'langan (`lesson_id NOT NULL`, xona voqealari), quvvat amali esa darssiz va ko'p xonali. Ijrochi — MeshAgent, adapter orqali (`requestPowerAction`). Companion ishtirok etmaydi. Fon ishi bitta `PowerWorker` (1 s tick):
- jadvaldan amal yaratadi;
- vaqti kelgan amalni boshlaydi;
- to'lqinlar bilan yuboradi;
- natijani `listDevices` kuzatuvi bilan aniqlaydi.

Yuborish ko'pi bilan bir marta (at-most-once): target avval `sent` deb commit qilinadi, keyin MeshCentral'ga yuboriladi. Hub qayta ishga tushsa, qayta yuborish bo'lmaydi.

**Tech Stack:** P1d/P1e bilan bir xil server steki (NestJS 11, Drizzle 0.45, zod 4, vitest 5). Yangi dependency yo'q. Vaqt mintaqasi `Intl.DateTimeFormat` bilan hisoblanadi; Node 24'da `Temporal` yo'q.

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md):
- §5.1: `requestPowerAction`, adapter chegarasi.
- §7.1: quvvat jadvali; ommaviy amal qurilma sonini ko'rsatib tasdiq so'raydi va bosqichma-bosqich bajariladi.
- §9: command lifecycle; reboot qayta yuborilganda dublikat bajarilmaydi; `unknown` + reconcile.
- §15.1: P1 qabul — o'chirish, qayta yuklash, yoqish, har qurilma natijasi.

[ADR 0007](../../adr/0007-central-university-management.md): rollar, himoya, WoL cheklovlari. Yo'l xaritasi: [P1h](2026-10-27-netschool-roadmap.md).

**Egasining qarorlari (2026-11-02):**
- Jadval: bir martalik (`runAt`) va takroriy (haftaning kunlari + `HH:MM` + IANA vaqt mintaqasi).
- Huquq `power.manage`:
  - org-wide `school_admin` (markaziy IT admin) — hamma site;
  - site `school_admin` va site `it_support` — faqat o'z site'i;
  - teacher va student — yo'q.
- P1f'ga IT admin uchun quvvat sahifasi kiradi (bu rejada faqat API).

**Fakt (upstream `meshuser.js`):**
- `poweraction` har nodeid uchun huquq tekshiruvidan oldin `result: 'ok'` qaytaradi. Huquq yo'q bo'lsa jimgina hech narsa qilmaydi.
- `wakedevices` bitta nodeid uchun diagnostik matn qaytaradi: `Used N device(s) to send wake packets`, `No known MAC addresses for this device`, `No network information for this device` yoki `Invalid nodeid`.
- Rights: `MESHRIGHT_RESETOFF = 0x40000`, `MESHRIGHT_WAKEDEVICE = 0x40`.
- `actiontype`: 2 — o'chirish, 3 — qayta yuklash, 4 — uxlatish.

## Global Constraints

- P1a–P1e Global Constraints amal qiladi:
  - xato konverti va correlation ID;
  - audit bitta tranzaksiyada;
  - begona yoki noma'lum ID → bir xil audit qilingan 403;
  - `@Inject` tokenlar, zod;
  - kod inglizcha, docs o'zbekcha;
  - TLS tekshiruvi o'chirilmaydi;
  - testlarda `vi.useFakeTimers` yo'q, vaqt `now` injeksiyasi bilan.
- MeshCentral protokolini faqat `packages/meshcentral-adapter` biladi (`nodeid`, `actiontype`, javob matnlari).
- Amal turlari: `shutdown | reboot | sleep | wake`. Teacher API'ga hech narsa qo'shilmaydi.
- Target holatlari: `pending | sent | succeeded | failed | unknown | cancelled`. `failed` sabablari: `unbound | device_offline | wake_unsupported | node_missing | upstream_unavailable`.
- Amal holatlari: `scheduled | running | completed | cancelled | missed`.
- Konstantalar (`packages/domain/src/power.ts`):
  - `POWER_WAVE_SIZE = 50`;
  - `POWER_WAVE_INTERVAL_MS = 5_000`;
  - `POWER_OUTCOME_DEADLINE_MS = { shutdown: 180_000, sleep: 180_000, reboot: 600_000, wake: 300_000 }`;
  - `POWER_SEND_GIVE_UP_MS = 600_000` (MeshCentral uzilgan bo'lsa, yuborilmagan target shuncha kutadi);
  - `POWER_MISSED_GRACE_MS = 600_000`;
  - `POWER_MAX_LEAD_MS = 30 * 86_400_000` (bir martalik `runAt` ko'pi bilan 30 kun oldinga).
- Tasdiq: aniqlangan qurilmalar soni > 1 bo'lsa, so'rovda `confirmDeviceCount` shu songa aynan teng bo'lishi shart. Aks holda 409 `confirmation_required`. Bu yangi error kodi.
- Retired qurilma hech qachon target bo'lmaydi. Mesh binding'i yo'q qurilma `failed: unbound` bo'ladi.
- Quvvat amallari xona `events` jurnaliga yozilmaydi (xona lock tartibiga tegmaydi). UI `GET /power-actions/{id}`ni so'rab turadi (P1f).

## Review Focus

1. **Service account'da qurilma guruhiga `RESETOFF`/`WAKEDEVICE` huquqi yo'q.** MeshCentral `ok` deydi, lekin hech narsa qilmaydi. Natija `succeeded` emas, muddat tugagach `unknown` bo'lishi kerak. → Task 4 `an accepted request with no observed change ends unknown`.
2. **Hub amal o'rtasida qayta ishga tushadi.** `sent` target qayta yuborilmaydi (ikki marta reboot yo'q), kuzatuv davom etadi. → Task 4 `a restarted worker never resends a sent target`.
3. **Jadval vaqtida hub o'chiq edi** (19:00 o'chirish, hub 08:00 da yondi). Ertalab dars paytida kompyuterlar o'chirilmaydi: amal `missed` bo'ladi, keyingi vaqt hisoblanadi, auditga yoziladi. → Task 5 `a schedule missed by more than the grace is skipped, not run late`.
4. **Ikki API replikasi bir vaqtda tick qiladi.** Har target bir marta yuboriladi, jadval bir vaqtga bitta amal yaratadi. → Task 4 `concurrent workers send each target once` (real PG); Task 5 `two ticks create one action per occurrence`.
5. **Admin tasdiqlagan son va haqiqiy son farq qiladi** (qurilma qo'shildi yoki ko'chirildi). Bir martalik amal 409 `confirmation_required` bilan rad etiladi. Jadval esa ishga tushganda joriy ko'lamni oladi, retired qurilmalar chiqariladi. → Task 3 `a stale confirmation count is rejected`; Task 5 `a scheduled run targets the current devices of its scope`.

---

### Task 0: Branch

- [ ] **Step 1:** `git switch main && git pull --ff-only && git switch -c p1h-power`. Shu rejani commit qilish: `docs: P1h power management plan`.

### Task 1: Domain va contracts

**Files:**
- Create: `packages/domain/src/power.ts`, `packages/contracts/src/api/v1/power.ts`
- Modify: `packages/domain/src/{index.ts,access/authorize.ts,ports/device-management.ts}`, `packages/contracts/src/index.ts`
- Test: `packages/domain/test/power.test.ts`, `packages/domain/test/authorize.test.ts`, `packages/contracts/test/power.test.ts`

**Interfaces — Produces:**

```typescript
// domain/power.ts
export type PowerActionType = 'shutdown' | 'reboot' | 'sleep' | 'wake';
export type PowerTargetStatus = 'pending' | 'sent' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
export type PowerFailureReason = 'unbound' | 'device_offline' | 'wake_unsupported' | 'node_missing' | 'upstream_unavailable';
export type PowerActionStatus = 'scheduled' | 'running' | 'completed' | 'cancelled' | 'missed';
// + Global Constraints'dagi konstantalar
export interface PowerObservation { agentOnline: boolean; powerState: PowerState } // null — node ro'yxatda yo'q
export function judgePowerTarget(
  type: PowerActionType,
  target: { sentAt: number; offlineSeenAt: number | null },
  observation: PowerObservation | null,
  now: number,
): { status: 'sent' | 'succeeded' | 'unknown'; offlineSeenAt: number | null };
export interface WeeklyRule { daysOfWeek: number[]; timeOfDay: string; timezone: string } // 1=Du … 7=Ya, 'HH:MM'
export function nextOccurrence(rule: WeeklyRule, afterMs: number): number; // afterMs dan qat'iy keyingi lahza
export function isValidTimezone(tz: string): boolean;
// ports/device-management.ts — DeviceManagementPort'ga qo'shiladi:
export interface AuthorizedPowerRequest { siteId: string; upstream: UpstreamDeviceRef; type: PowerActionType }
export type PowerRequestResult = { accepted: true } | { accepted: false; reason: 'wake_unsupported' | 'node_missing' };
requestPowerAction(request: AuthorizedPowerRequest): Promise<PowerRequestResult>;
// access: Action += 'power.manage' (SITE_ADMIN_ACTIONS va IT_SUPPORT_ACTIONS'ga)
```

`judgePowerTarget` qoidalari (birinchi mos kelgani):
- `shutdown`: `!agentOnline` yoki `powerState === 'off'` → `succeeded`.
- `sleep`: `!agentOnline` yoki `powerState === 'sleep'` → `succeeded`.
- `reboot`: `!agentOnline` → `sent`, `offlineSeenAt = offlineSeenAt ?? now`; `agentOnline && offlineSeenAt !== null` → `succeeded`.
- `wake`: `agentOnline` → `succeeded`.
- Boshqa holatda: `now − sentAt ≥ deadline[type]` → `unknown`, aks holda `sent`.

`nextOccurrence`: kunma-kun oldinga yuriladi (≤ 8 kun). Mahalliy devor vaqti UTC'ga ikki o'tishli offset bilan aylantiriladi (`Intl.DateTimeFormat(…, { timeZone, hourCycle: 'h23' })` qismlaridan offset):
- `o1 = offset(wallAsUtc)`, `t1 = wallAsUtc − o1`, `o2 = offset(t1)`;
- `o1 === o2` → `t1`;
- aks holda `t2 = wallAsUtc − o2`; `t2` mahalliy vaqtda devor vaqtiga teng bo'lsa `t2`, aks holda (DST oralig'i) `max(t1, t2)`.

**Contracts (`power.ts`):**

```typescript
export const powerScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('organization') }),
  z.object({ kind: z.literal('sites'), siteIds: z.array(z.uuid()).min(1).max(50) }),
  z.object({ kind: z.literal('rooms'), roomIds: z.array(z.uuid()).min(1).max(200) }),
  z.object({ kind: z.literal('devices'), deviceIds: z.array(z.uuid()).min(1).max(500) }),
]);
powerActionTypeSchema; // enum 4 tur
createPowerActionRequestSchema = { type, scope, runAt?: iso datetime, confirmDeviceCount?: int ≥ 0 }
previewPowerRequestSchema = { type, scope }
powerPreviewSchema = { deviceCount, unbound, agentOnline: int | null, agentOffline: int | null } // null — MeshCentral javob bermadi
powerTargetSchema = { deviceId, hostname, siteId, roomId: uuid | null, status, reason: reason | null, sentAt | null, finishedAt | null }
powerActionSchema = { id, type, scope, status, runAt, scheduleId: uuid | null, requestedBy: uuid | null, createdAt, completedAt | null,
                      summary: Record<PowerTargetStatus, number>, targets?: PowerTarget[] } // targets faqat GET /{id} da
weeklyRuleSchema = { daysOfWeek: int 1..7 array, unikal, 1..7 ta; timeOfDay: /^([01]\d|2[0-3]):[0-5]\d$/; timezone: refine(isValidTimezone) }
createPowerScheduleRequestSchema = { type, scope, rule: weeklyRule, confirmDeviceCount?: int ≥ 0 }
updatePowerScheduleRequestSchema = { enabled?, rule? } // kamida bittasi; ko'lam va tur o'zgarmaydi
powerScheduleSchema = { id, type, scope, rule, enabled, nextRunAt | null, createdBy, createdAt }
```

- [ ] **Step 1: Failing testlar**
  - `judgePowerTarget`:
    - `shutdown succeeds when the agent goes offline`;
    - `sleep succeeds on powerState sleep while still connected`;
    - `reboot needs offline then online` (online → `sent`; offline → `sent` + `offlineSeenAt`; keyin online → `succeeded`);
    - `wake succeeds when the agent comes online`;
    - `a missing node waits until the deadline then is unknown`;
    - `deadline is per type` (`reboot`, `sentAt+599_999` → `sent`; `+600_000` → `unknown`).
  - `nextOccurrence`:
    - `Asia/Tashkent Mon–Fri 19:00 from Monday 18:00 local` → `Date.parse('2026-11-02T14:00:00Z')`, `afterMs = Date.parse('2026-11-02T13:00:00Z')`;
    - `exactly at the occurrence moves to the next working day`: Fri `2026-11-06T14:00:00Z` → `2026-11-09T14:00:00Z`;
    - `DST gap shifts forward`: `Europe/Berlin`, har kun `02:30`, after `2027-03-28T00:00:00Z` → `2027-03-28T01:30:00Z`;
    - `isValidTimezone('Mars/Base') === false`.
  - authorize:
    - `site it_support and site admin may manage power on their site only`;
    - `teacher and student may not manage power`;
    - `organization-wide power needs an org school_admin` (`siteId: undefined` target).
  - contracts:
    - `scope kinds parse and reject empty id lists`;
    - `weekly rule rejects 24:00, duplicate days, day 0`;
    - `update needs enabled or rule`.
- [ ] **Step 2:** `pnpm vitest run --project unit packages/domain packages/contracts` → FAIL (modullar yo'q).
- [ ] **Step 3:** Implement. Hamma `DeviceManagementPort` implementatsiyalari: hozircha `FakeMesh` (`apps/api/test/support/mesh.ts`) va `MeshCentralDeviceManagement`. Adapter Task 2'da to'ldiriladi; `pnpm typecheck` o'tishi uchun bu yerda `throw new Error('not implemented')` stub qo'yiladi.
- [ ] **Step 4:** → PASS; `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(domain): power actions, outcome rules and weekly schedules`.

### Task 2: Adapter `requestPowerAction`

**Files:**
- Modify: `packages/meshcentral-adapter/src/device-management.ts`, `apps/api/test/support/mesh.ts` (`FakeMesh`)
- Test: `packages/meshcentral-adapter/test/device-management.test.ts` (fake requester), `tests/contracts/adapter.test.ts` (real MeshCentral)

**Interfaces:**
- Consumes: Task 1 `AuthorizedPowerRequest`, `PowerRequestResult`; mavjud `formatNodeId(ref)`, `MeshRequester.request`.
- Produces: `MeshCentralDeviceManagement.requestPowerAction`. `FakeMesh` qo'shimchalari:

```typescript
readonly powerRequests: Array<{ siteId: string; nodeId: string; type: PowerActionType }>;
wakeResults: Map<string, PowerRequestResult>; // berilmasa { accepted: true }
nodes.get(id).powerState?: PowerState;          // berilmasa online ? 'on' : 'unknown'
powerFailing = false;                           // true → requestPowerAction AdapterError('upstream_timeout')
```

Xatti-harakat:
- Scope: `upstream` site scope'iga (`meshInstanceId`, `meshDomainId`) mos bo'lmasa `AdapterError('scope_denied')` (`reconcileEnrollment` naqshi).
- `shutdown | reboot | sleep` → `request('poweraction', { nodeids: [formatNodeId(ref)], actiontype: 2 | 3 | 4 })`. Javob `result === 'ok'` → `{ accepted: true }`, boshqasi → `AdapterError('invalid_upstream_message')`.
- `wake` → `request('wakedevices', { nodeids: [id] })`. `result` qiymatlari:
  - `'ok'` yoki `/^Used \d+ device\(s\)/` → `accepted`;
  - `No known MAC…` | `No network information…` → `wake_unsupported`;
  - `Invalid nodeid` | `Invalid domain` → `node_missing`;
  - boshqa → `invalid_upstream_message`.
- Har chaqiruv bitta node uchun. Ko'p nodeid'li `poweraction` bitta `responseid` bilan bir nechta javob yuboradi (upstream sikl).

- [ ] **Step 1: Failing testlar**
  - fake requester:
    - `power actions map to MeshCentral action types` (yuborilgan payload'lar 2/3/4 va to'liq nodeid);
    - `wake results map to accepted, wake_unsupported and node_missing` (4 matn);
    - `a node outside the site scope is refused before sending` (requester chaqirilmaydi).
  - contract (real):
    - `requestPowerAction accepts shutdown for a listed device`;
    - `waking a local device without network information is wake_unsupported` (harness'dagi lokal qurilmalar).
- [ ] **Step 2:** `pnpm vitest run --project unit packages/meshcentral-adapter` → FAIL.
- [ ] **Step 3:** Implement adapter va `FakeMesh`.
- [ ] **Step 4:** unit → PASS; `pnpm test:contract` (yoki `vitest run --project contract tests/contracts/adapter.test.ts`) → PASS.
- [ ] **Step 5:** Commit `feat(adapter): power actions and wake through MeshCentral`.

### Task 3: Sxema, amal yaratish, ko'rish, bekor qilish

**Files:**
- Create: `apps/api/src/modules/power/{power.module.ts,power-scope.ts,power.service.ts,power.controller.ts}`, `apps/api/drizzle/0010_*.sql` (`drizzle-kit generate`)
- Modify: `apps/api/src/db/schema.ts`, `apps/api/test/support/db.ts` (`TABLES`), `apps/api/src/app.ts`, `apps/api/src/common/errors.ts` (`confirmation_required: 409`, xabar `Device count confirmation required`)
- Test: `apps/api/test/power-actions.test.ts`, `apps/api/test/db-invariants.test.ts`

**Sxema:**
- `power_actions`:
  - `id`, `organization_id`, `type` (check 4);
  - `scope jsonb`, `site_ids uuid[] not null` (ruxsat tekshiruvi uchun; `organization` ko'lamida yaratilgan paytdagi barcha site'lar);
  - `status` (check 5), `run_at`;
  - `schedule_id null` → `power_schedules`;
  - `requested_by null` (jadval amalida `null`) → `users (organization_id, id)`;
  - `next_wave_at null`, `created_at`, `completed_at null`.
  - Unique `(schedule_id, run_at)`. Indeks: `(status, run_at)`.
- `power_action_targets`:
  - `action_id` (cascade), `device_id`, `organization_id`, `site_id`;
  - `status` (check 6), `reason` — check: `(status='failed') = (reason is not null)`, 5 sabab;
  - `sent_at`, `offline_seen_at`, `finished_at`, `updated_at`.
  - PK `(action_id, device_id)`. FK `(organization_id, device_id)` → `devices`. Partial indeks `status in ('pending','sent')`.
- `power_schedules`:
  - `id`, `organization_id`, `type`, `scope jsonb`, `site_ids uuid[]`;
  - `days_of_week smallint[]`, `time_of_day text`, `timezone text`;
  - `enabled bool`, `next_run_at null`, `created_by`, `created_at`, `updated_at`.

`power_schedules` shu migratsiyada yaratiladi; servisi Task 5'da.

**Marshrutlar (sessiya, `power.manage`):**
- `POST /api/v1/power-actions/preview` → 200 `PowerPreview`. `agentOnline`/`agentOffline` har site uchun `listDevices` orqali olinadi; MeshCentral javob bermasa ikkalasi `null`.
- `POST /api/v1/power-actions` (`Idempotency-Key` majburiy) → 202 `PowerAction`.
  - `runAt` yo'q yoki ≤ now → `running`, targetlar shu tranzaksiyada yaratiladi.
  - `runAt` kelajakda (≤ `POWER_MAX_LEAD_MS`) → `scheduled`, targetlar boshlanganda yaratiladi (Task 4).
  - 0 qurilma → 409 `conflict`.
- `GET /api/v1/power-actions?limit=1..100` (default 50, `created_at desc`) → faqat actor `site_ids`ning hammasiga ruxsatli amallar; `organization` ko'lamidagilar faqat org admin'ga.
- `GET /api/v1/power-actions/{id}` → `targets` bilan.
- `POST /api/v1/power-actions/{id}/cancel` → 200 `PowerAction`, audit `power.cancel`.
  - `scheduled` → `cancelled`.
  - `running` → `pending` targetlar `cancelled`; `sent` targetlar kuzatuvda qoladi.
  - Yakunlangan amal → o'zgarishsiz 200.

```typescript
// power-scope.ts
export interface ResolvedScope { siteIds: string[]; devices: Array<{ id: string; siteId: string; roomId: string | null; bound: boolean }> }
export async function authorizeScope(access: Access, ctx: RequestContext, scope: PowerScope): Promise<void>; // har site uchun require('power.manage'); organization → { organizationId } (siteId yo'q); noma'lum/begona id → access.deny
export async function resolveScope(db: Db, organizationId: string, scope: PowerScope): Promise<ResolvedScope>; // retired chiqariladi
@Injectable() export class PowerService {
  preview(ctx, input): Promise<PowerPreview>;
  create(ctx, input, key: string): Promise<{ status: number; body: PowerAction }>;
  list(ctx, limit: number): Promise<PowerAction[]>;
  get(ctx, id: string): Promise<PowerAction>;
  cancel(ctx, id: string): Promise<PowerAction>;
  // Task 4/5 ishlatadi: amal uchun targetlar (unbound → failed, qolgani pending), status running, next_wave_at = now
  materialize(tx: Db, actionId: string, now: number): Promise<void>;
}
```

Audit `power.request`: `targetType 'power_action'`, `details { type, scope, deviceCount, runAt }`.

- [ ] **Step 1: Failing testlar**
  - `org admin shuts down the whole organization after confirming the count`: 3 site × 2 qurilma, `confirmDeviceCount: 6` → 202, 6 ta `pending`.
  - `a stale confirmation count is rejected`: `confirmDeviceCount: 5` → 409 `confirmation_required`, amal yozilmaydi.
  - `a single device needs no confirmation`.
  - `site it_support may target its own site and not another`: boshqa site → 403 audit bilan; noma'lum device UUID ham xuddi shu 403.
  - `teacher may not manage power`.
  - `organization scope needs an org admin`: site admin → 403.
  - `unbound devices fail as unbound and retired devices are not targeted`.
  - `preview counts devices and agent state` (MeshCentral yo'q → `null`lar).
  - `the same Idempotency-Key returns the same action`.
  - `a future runAt is scheduled without targets; more than 30 days ahead is a validation error`.
  - `cancelling a scheduled action and a running one`.
  - `list hides actions on sites the actor cannot manage`.
  - db-invariants:
    - `power target reason goes with failed only`;
    - `one action per schedule occurrence`.
- [ ] **Step 2:** `pnpm vitest run --project unit apps/api/test/power-actions.test.ts` → FAIL.
- [ ] **Step 3:** Sxema → `pnpm --filter @netschool/api drizzle-kit generate` → implement.
- [ ] **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): power actions with scope, confirmation and audit`.

### Task 4: `PowerWorker`: boshlash, to'lqinlar, natija

**Files:**
- Create: `apps/api/src/modules/power/power.worker.ts`
- Modify: `apps/api/src/modules/power/power.module.ts` (`WORKERS_ENABLED`, `MESH_LINK`, `DEVICE_MANAGEMENT`)
- Test: `apps/api/test/power-worker.test.ts`, `apps/api/test/concurrency.pg.test.ts`

**Interfaces:**
- Consumes: Task 1 (`judgePowerTarget`, konstantalar), Task 2 (`requestPowerAction`, `FakeMesh`), Task 3 (`PowerService.materialize`).
- Produces:

```typescript
@Injectable() export class PowerWorker implements OnApplicationBootstrap, OnModuleDestroy {
  tick(now: number): Promise<void>; // startDue → dispatch → reconcile → finish; Task 5 runSchedules'ni boshiga qo'shadi
}
```

`tick` bosqichlari, har biri alohida qisqa tranzaksiyalarda (tashqi chaqiruv tranzaksiyadan tashqarida, `OutboxWorker` naqshi):

1. **startDue.** `scheduled` va `run_at ≤ now` amallar `FOR UPDATE SKIP LOCKED` bilan olinadi.
   - `now − run_at > POWER_MISSED_GRACE_MS` → `missed`, audit `power.missed`.
   - Aks holda `materialize`.
2. **dispatch.** `MESH_LINK.connected === false` bo'lsa yuborilmaydi; faqat `run_at`dan `POWER_SEND_GIVE_UP_MS` o'tgan `pending` targetlar `failed: upstream_unavailable` bo'ladi. Aks holda har `running` amal `next_wave_at ≤ now` bilan `FOR UPDATE SKIP LOCKED` olinadi:
   - ≤ `POWER_WAVE_SIZE` `pending` target (`device_id` tartibida) va binding'lari olinadi.
   - Bitta `listDevices` (har site) bilan holat tekshiriladi:
     - `shutdown | reboot | sleep` va agent offline → `failed: device_offline`;
     - `wake` va agent online → `succeeded`;
     - qolganlari `sent`, `sent_at = now`.
   - `next_wave_at = now + POWER_WAVE_INTERVAL_MS`. **Commit**, keyin yuborish.
   - Har `sent` target uchun `requestPowerAction` (parallel, ≤ 16):
     - `{ accepted: false, reason }` → `failed: reason` (shartli `where status = 'sent'`);
     - istisno → target `sent` qoladi (yuborilgan bo'lishi mumkin; natijani kuzatuv hal qiladi).
   - `listDevices` xatosi → to'lqin olinmaydi, keyingi tick.
3. **reconcile.** `sent` targetli site'lar bo'yicha bitta `listDevices`. Har target uchun `judgePowerTarget`; o'zgarsa shartli yangilanadi (`where status = 'sent'`).
4. **finish.** `pending`/`sent` targeti qolmagan `running` amal → `completed`, `completed_at`, audit `power.completed` (`details: summary`, actor `null`).

Interval: `WORKERS_ENABLED` bo'lsa `setInterval(1_000)`, `#running` qayta kirishdan himoya.

- [ ] **Step 1: Failing testlar** (`startTestApp({ deviceManagement: mesh.factory, mesh: { connected: true } })`, `tick(now)` qo'lda)
  - `a running action sends in waves of 50 every 5 seconds`: 120 qurilma → tick(t) 50, tick(t+1000) 0, tick(t+5000) yana 50, tick(t+10000) 20.
  - `shutdown succeeds when the agent goes offline and the action completes`.
  - `reboot succeeds only after offline then online`.
  - `an accepted request with no observed change ends unknown`: `reboot`, `sent_at+600_000` → `unknown`, amal `completed`.
  - `offline devices fail as device_offline at send time; wake skips devices already on as succeeded`.
  - `wake on a device without MAC fails as wake_unsupported`.
  - `a restarted worker never resends a sent target`: `mesh.powerFailing = true` → target `sent`; yangi `startTestApp` (o'sha DB) bilan tick'lar → `powerRequests` uzunligi o'zgarmaydi.
  - `nothing is sent while MeshCentral is disconnected and pending targets give up after 10 minutes`.
  - `a scheduled action starts at runAt; one late by more than the grace is missed`.
  - concurrency.pg: `concurrent workers send each target once` — ikki `PowerWorker` (ikki app, bitta DB), 60 target, 3 ta parallel tick juftligi → har `deviceId` `powerRequests`da aynan bir marta.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; real PG: `TEST_DATABASE_URL=… pnpm vitest run --project unit apps/api/test/concurrency.pg.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(api): power worker with waves, at-most-once send and observed outcomes`.

### Task 5: Haftalik jadvallar

**Files:**
- Create: `apps/api/src/modules/power/{power-schedules.service.ts,power-schedules.controller.ts}`
- Modify: `apps/api/src/modules/power/{power.worker.ts,power.module.ts}`
- Test: `apps/api/test/power-schedules.test.ts`

**Marshrutlar (sessiya, `power.manage`, ko'lam bo'yicha Task 3 `authorizeScope`):**
- `POST /api/v1/power-schedules` (`Idempotency-Key`) → 201 `PowerSchedule`. Tasdiq qoidasi amal bilan bir xil; 0 qurilma ruxsat. `next_run_at = nextOccurrence(rule, now)`.
- `GET /api/v1/power-schedules` → ruxsatli jadvallar.
- `PATCH /api/v1/power-schedules/{id}` → `enabled`/`rule`. `rule` yoki `enabled: true` o'zgarsa `next_run_at` qayta hisoblanadi; `enabled: false` → `null`.
- `DELETE /api/v1/power-schedules/{id}` → 204. Yaratilgan amallar qoladi (`schedule_id` FK `on delete set null`).

Audit: `power.schedule_create | power.schedule_update | power.schedule_delete`.

**`runSchedules(now)`** (`PowerWorker.tick` boshida): `enabled` va `next_run_at ≤ now` jadvallar `FOR UPDATE SKIP LOCKED` bilan olinadi.
- `now − next_run_at > POWER_MISSED_GRACE_MS` → `missed` holatli amal yoziladi (targetsiz, audit `power.missed`).
- Aks holda amal `run_at = next_run_at`, `requested_by = null`, ko'lam `resolveScope` bilan joriy holatda. Keyin `materialize`.
- Har ikki holatda `next_run_at = nextOccurrence(rule, now)`. `(schedule_id, run_at)` unique: `ON CONFLICT DO NOTHING`.

- [ ] **Step 1: Failing testlar**
  - `creating a schedule computes the next run in its timezone`.
  - `a due schedule creates one running action and advances`.
  - `two ticks create one action per occurrence`.
  - `a schedule missed by more than the grace is skipped, not run late`: `next_run_at` 11 daqiqa oldin → `missed` amal, `powerRequests` bo'sh, `next_run_at` kelajakda.
  - `a scheduled run targets the current devices of its scope`: yaratilgandan keyin bitta qurilma retired, bittasi xonaga qo'shilgan → targetlar joriy ro'yxat.
  - `disabling clears the next run; re-enabling recomputes it`.
  - `site it_support cannot see or change another site's schedule` (403 audit).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): weekly power schedules`.

### Task 6: Hujjatlar

**Files:**
- Create: `docs/adr/0010-power-management.md`
- Modify: `docs/superpowers/plans/2026-10-27-netschool-roadmap.md` (P1h holati), `docs/adr/0006-lessons-commands.md` ("Power/reboot — keyingi bosqich" → ADR 0010 havolasi)

- [ ] **Step 1:** ADR 0010:
  - qarorlar: alohida jadvallar va sababi; at-most-once; kuzatuv qoidalari va muddatlari; to'lqinlar; tasdiq; `missed`; rollar;
  - cheklovlar: service account huquqi yo'q bo'lsa `unknown`; WoL faqat segmentda yoqiq agent bo'lsa; real agent sinovi P0c'da; default bo'lmagan MeshCentral domain'i tekshirilmagan; xona voqealari yo'q (UI so'raydi);
  - dalillar: test fayllari.
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm test` → PASS. Commit `docs: record power management decisions`.
