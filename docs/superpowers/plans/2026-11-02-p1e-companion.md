# P1e — Companion (o'quvchi, Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maktab kompyuterida o'quvchi Companion'i ishlaydi. IT admin uni bir marta ro'yxatdan o'tkazadi (fail-closed TLS). Companion hub'ga imzolangan kanal orqali heartbeat yuboradi va buyruqlarni oladi: xabar va yumshoq overlay (120 s lease, monoton taymer; reboot'dan keyin eskirgan lock qaytmaydi). O'quvchi "yordam" (qo'l ko'tarish) bosa oladi. Dars davomida ekran miniaturasi (JPEG, ≤480 px, 1 fps) hub'ga boradi; hub oxirgi kadrni faqat xotirada saqlaydi va uni faqat dars egasiga beradi.

**Architecture:** Yangi `apps/companion`. `src/core/` — Electron'siz toza Node modullari (imzo, hub klienti, enrollment, SQLite cache, overlay lease, buyruqlar, miniatura yuklovchi, agent); vitest bilan real API'ga (`startTestApp`) qarshi sinaladi. `src/main/` — Electron qobig'i (oynalar, tray, `desktopCapturer`, IPC). `src/preload/` — allowlist IPC. `src/renderer/` — sandbox'dagi oddiy TS sahifalar (React yo'q). Qurilma protokoli P1b/P1c'niki: NSDEV1 imzo, heartbeat 10 s, buyruqlar long-poll orqali (ADR 0006 qarori saqlanadi). WS faqat binary miniaturalar uchun: `/api/v1/device/thumbnails`, API jarayonida, imzolangan upgrade bilan, oxirgi kadr xotirada (§11). Help request — yangi server moduli. Qurilma kaliti mashina bo'yicha: admin `enroll` yozadi, har OS user sessiyasidagi Companion o'qiydi. P2d'da kalit OS Helper'ga o'tadi.

**Tech Stack:** Electron **45.2.1** (Node 24.22.1; `node:sqlite` Electron ichida ishlashi tekshirildi), esbuild (main ESM, preload CJS, renderer), `ws` 8, zod 4, Playwright 1.64.1 `_electron` (e2e smoke). Server tomoni P1d bilan bir xil, yangi dependency yo'q.

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md):
- §3: o'quvchi paneli, miniaturalar.
- §4: Electron, renderer'da Node huquqi yo'q; Companion'da SQLite.
- §6: Companion oddiy OS user ostida; sandbox, contextIsolation, cheklangan preload IPC; enrollment.
- §7: capability = holat + sabab; soft overlay interfeysda soft deb ko'rsatiladi.
- §8: presence, help_requests.
- §10: overlay lease 120 s; heartbeat 10 s; monoton taymer; reboot.
- §11: binary JPEG WS, 320–480 px, 1–2 fps; latest frame; backpressure; kadr DB/audit'ga yozilmaydi.
- §13: TLS; endpoint hub'ga o'zi ulanadi.
- §14: prototip transporti fail-closed ishonch tekshiruvi bilan almashtiriladi.
- §15.1: help/message, soft overlay; server o'chsa overlay cheksiz qolmaydi; reboot'dan keyin eskirgan lock qaytmaydi.

Yo'l xaritasi: [2026-10-27-netschool-roadmap.md](2026-10-27-netschool-roadmap.md) (P1e). Oldingi qarorlar: [ADR 0005](../../adr/0005-devices-enrollment.md), [ADR 0006](../../adr/0006-lessons-commands.md), [ADR 0008](../../adr/0008-remote-sessions.md).

**Egasining qarorlari (2026-11-02):**
- P1d (PR #7) avval tugatilib merge qilinadi; P1e `main`dan boshlanadi.
- Qurilma kaliti mashina bo'yicha, admin `enroll` bilan yoziladi.
- Help — faqat qo'l ko'tarish, matnsiz. Chat 2-bosqichda.

## Global Constraints

**Umumiy:**
- P1a–P1d Global Constraints amal qiladi: xato konverti, correlation ID, audit bitta tranzaksiyada, begona/noma'lum ID → bir xil audit qilingan 403, `@Inject` tokenlar, zod, kod inglizcha, docs o'zbekcha, TLS tekshiruvi hech qachon o'chirilmaydi.
- Testlarda tarmoq bilan `vi.useFakeTimers` ishlatilmaydi (P1d CI saboqi: pg-pool taymerlari). Vaqt `MonotonicClock`/`now` injeksiyasi va qisqa intervallar bilan boshqariladi.

**Electron va renderer:**
- Electron `45.2.1`, aniq pin. Har oynada `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`.
- Renderer faqat ilovaning o'z `file://` sahifalarini yuklaydi. CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'`.
- Barcha permission so'rovlari rad etiladi; navigatsiya va `window.open` taqiqlangan.
- Rendererga kalit, DB, hub URL'i yoki imzo berilmaydi.

**Mashina va per-user fayllar:**
- Mashina katalogi:
  - Windows: `%ProgramData%\NetSchool\companion`
  - macOS: `/Library/Application Support/NetSchool/companion`
  - Linux: `/var/lib/netschool/companion`
  - override: `NETSCHOOL_COMPANION_DIR`
- Mashina katalogidagi fayllar: `device.json` (`hubOrigin`, `deviceId`, `siteId`, `publicKey`, `enrolledAt`), `device.key` (PKCS#8 PEM), ixtiyoriy `hub-ca.pem`.
  - Ularni faqat `enroll` yozadi, Companion faqat o'qiydi.
  - POSIX'da katalog `0o755`, fayllar `0o644`. P2d'gacha qurilmadagi har OS user kalitni o'qiy oladi (ADR 0009 cheklovi).
- Per-user holat: `<userData>/state.sqlite` (`node:sqlite`); override `NETSCHOOL_COMPANION_STATE_DIR`.
- Bitta OS user'da bitta nusxa: `app.requestSingleInstanceLock()`.

**TLS (fail-closed):**
- Hub origin faqat `https:`.
- `hub-ca.pem` bo'lsa faqat unga ishoniladi (`https.Agent({ ca })`, tizim root'lari emas); bo'lmasa tizim root'lari.
- Hostname har doim tekshiriladi. TLS xatosi → ulanish yo'q, status `tls_error`; fallback va `rejectUnauthorized: false` yo'q.

**Qurilma protokoli (o'zgarmaydi, ADR 0005/0006):**
- Claim proof `NSCLAIM1\n<token>\n<publicKey>`; so'rov imzosi `NSDEV1\n<METHOD>\n<path+query>\n<ts>\n<sha256(body)>`.
- Imzo timestamp'i jarayon ichida qat'iy o'sadi: `ts = max(Date.now() + clockOffsetMs, last + 1)`.
- 401 kelsa so'rov bir marta qayta imzolanadi. Javobdagi `Date` sarlavhasi qurilma soatidan 5 s dan ko'p farq qilsa, `clockOffsetMs` shu farqqa o'rnatiladi.
- Heartbeat 10 s; long-poll `wait=25`.

**Overlay:**
- Lease `leaseSeconds` (120 s) bo'yicha hisoblanadi: jarayon ichida `performance.now()`, restart'lar orasida `os.uptime()`. Lease hech qachon `Date.now()` bilan hisoblanmaydi.
- Holat faqat `sequence` (BigInt) teng yoki yangiroq bo'lsa qo'llanadi.
- Saqlangan lock faqat bitta boot ichida tiklanadi. Bir boot: `|bootTimeMs − saqlangan| ≤ 2000`, `bootTimeMs = Date.now() − os.uptime()·1000`.
- Overlay matni: «Yumshoq bloklash» (soft ekanligi ko'rinadi).

**Miniaturalar:**
- Faqat heartbeat'da `lesson.thumbnails` bo'lsa olinadi. JPEG, kenglik ≤ `THUMBNAIL_MAX_WIDTH` (480).
- Interval server bergan qiymat (`THUMBNAIL_INTERVAL_MS` = 1000); Companion `THUMBNAIL_CLIENT_MIN_INTERVAL_MS` (500) dan tez yubormaydi.
- Kadr limiti `THUMBNAIL_MAX_BYTES` (262 144). Hub `THUMBNAIL_SERVER_MIN_INTERVAL_MS` (400) dan tez kelgan kadrni tashlaydi.
- Hub har qurilmaning faqat oxirgi kadrini xotirada saqlaydi, `THUMBNAIL_TTL_MS` (10 000) davomida.
- Kadr diskka, DB'ga, outbox'ga, auditga va logga yozilmaydi.
- Kadr qaysi dars uchun olingan bo'lsa, faqat o'sha dars uchun beriladi.

**Help:**
- Matnsiz. Bir `(lesson, device)` uchun eng ko'pi bitta ochiq so'rov.
- Yopilish sababi (`clear_reason`): `teacher` (egasi/admin), `device`, `lesson_ended`, `device_left`.
- Help audit qilinmaydi (receipt'lar kabi); faqat events.

**Capability:**
- Companion hisoboti:
  - `classroom.message`: `available`.
  - `classroom.overlay`: `available`, `enforcement: 'soft'`.
  - `classroom.help`: `available`.
  - `classroom.thumbnails`:
    - `available`;
    - yoki `requires_permission` (`provider: 'macos_screen_recording'`, macOS'da ekran ruxsati `granted` emas);
    - yoki `unsupported` (`reason: 'wayland_not_certified'`, Linux Wayland).
- `remote.desktop` hisobot qilinmaydi (manba MeshAgent, P0c).
- Capability har 30 s qayta hisoblanadi; faqat o'zgarsa `PUT` qilinadi.

**Server tomoni:**
- Yangi action `help.clear`: rollar `command.issue` bilan bir xil.
- Yangi event'lar: `help_request.raised`, `help_request.cleared`.
- Yangi error kodi yo'q. Lokal: `uz` (default), `ru`, `en`.

## Review Focus

1. **Kompyuter soati noto'g'ri** (CMOS, ±minutlar) → imzolangan so'rovlar 401 bilan to'xtab qolmaydi: birinchi 401'dagi `Date` sarlavhasidan offset olinib qayta imzolanadi. Overlay lease soatdan mustaqil. → Task 6 `a skewed device clock is corrected from the hub Date header`; Task 7 `a wall-clock jump does not extend the lease`.
2. **Hub o'chadi yoki tarmoq uziladi (overlay qulflangan)** → overlay ≤120 s ichida tushadi, status `offline` va oxirgi aloqa vaqti ko'rsatiladi. Hub qaytganda teacher'ning joriy istalgan holati heartbeat'dan olinadi. → Task 7 `server silence releases the overlay after 120 seconds`; Task 9 `the overlay falls when the hub stops answering`, `an unlock issued while the device was offline applies from the first heartbeat`.
3. **O'quvchi lock paytida Companion'ni o'ldirib qayta ochadi yoki kompyuterni qayta yuklaydi** → bitta boot ichida overlay qolgan lease muddatigacha qaytadi; reboot'dan keyin eskirgan lock qaytmaydi. → Task 7 `restart within the same boot restores the remaining lease`, `reboot discards the cached lock`; Task 11 `relaunching while locked restores the overlay`.
4. **Hub sertifikati noto'g'ri** (boshqa CA, boshqa nom) **yoki admin `--ca` bermagan** → `enroll` hech narsa yozmasdan nolga teng bo'lmagan kod bilan chiqadi. Ishlab turgan Companion ulanmaydi, `tls_error` ko'rsatadi, xavfsiz bo'lmagan fallback yo'q. → Task 6 `refuses a hub certificate signed by another CA`, `refuses a certificate issued for another hostname`, `an untrusted hub certificate fails before anything is written`; Task 9 `a TLS failure shows tls_error and keeps retrying`.
5. **macOS'da Screen Recording ruxsati yo'q yoki Linux Wayland** → `classroom.thumbnails` `requires_permission` yoki `unsupported` bo'ladi. Bo'sh kadr yuborilmaydi, qolgan funksiyalar ishlaydi. Ruxsat berilgach 30 s ichida qayta hisoblanadi. → Task 6 `macOS without screen access requires permission for thumbnails`, `Wayland thumbnails are unsupported`; Task 9 `capabilities are sent at start and again only when they change`; Task 8 `null frames from the source are not sent`.

---

### Task 0: Shart va branch

- [ ] **Step 1:** P1d tugagan: race 1 (binding'ni ochish tranzaksiyasi ichida `FOR SHARE` bilan qayta tekshirish) va GitGuardian fixture tuzatilgan, PR #7 merge qilingan. Tekshirish: `gh pr view 7 -R humoyun-dev/net-school --json state` → `MERGED`. Merge bo'lmagan bo'lsa to'xta va egasiga ayt.
- [ ] **Step 2:** `git switch main && git pull --ff-only && git switch -c p1e-companion`. Shu reja faylini birinchi commit qilish: `docs: P1e companion plan`.

### Task 1: Domain, contracts va heartbeat yo'riqnomasi

**Files:**
- Create: `packages/domain/src/{thumbnails.ts,help-requests.ts}`, `packages/contracts/src/api/v1/help-requests.ts`
- Modify: `packages/domain/src/{access/authorize.ts,index.ts}`, `packages/contracts/src/api/v1/{devices.ts,commands.ts}`, `packages/contracts/src/index.ts`, `apps/api/src/modules/devices/presence.service.ts`, `apps/api/src/modules/events/events.service.ts` (snapshot'ga `helpRequests: []`, Task 2 to'ldiradi)
- Test: `packages/domain/test/authorize.test.ts`, `packages/contracts/test/help-requests.test.ts`, `apps/api/test/device-presence.test.ts`

**Interfaces:**
- Produces:

```typescript
// domain
Action += 'help.clear'; // command.issue bilan bir xil: dars egasi teacher, site/org admin; it_support va student — yo'q
export type HelpClearReason = 'teacher' | 'device' | 'lesson_ended' | 'device_left';
export const THUMBNAIL_INTERVAL_MS = 1_000;
export const THUMBNAIL_CLIENT_MIN_INTERVAL_MS = 500;
export const THUMBNAIL_SERVER_MIN_INTERVAL_MS = 400;
export const THUMBNAIL_MAX_WIDTH = 480;
export const THUMBNAIL_MAX_BYTES = 262_144;
export const THUMBNAIL_TTL_MS = 10_000;
// contracts (devices.ts) — heartbeatLessonSchema'ga qo'shiladi (majburiy maydonlar):
thumbnails: z.object({ intervalMs: z.int().positive(), maxWidth: z.int().min(160).max(480) }).nullable(),
helpRequest: z.object({ id: z.uuid(), raisedAt: timestamp }).nullable(),
export type HeartbeatLesson = z.infer<typeof heartbeatLessonSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
// contracts (help-requests.ts)
export const helpRequestSchema = z.object({
  id: z.uuid(), lessonId: z.uuid(), deviceId: z.uuid(), raisedAt: timestamp,
  clearedAt: timestamp.nullable(), clearReason: z.enum(['teacher', 'device', 'lesson_ended', 'device_left']).nullable(),
});
export type HelpRequest = z.infer<typeof helpRequestSchema>;
export const deviceHelpRequestBodySchema = z.strictObject({});
// contracts (commands.ts)
eventSchema.type += 'help_request.raised' | 'help_request.cleared';
eventsResponseSchema.snapshot += helpRequests: z.array(helpRequestSchema); // darsning ochiq so'rovlari
```

- Heartbeat: faol darsdagi qurilmaga `thumbnails: { intervalMs: THUMBNAIL_INTERVAL_MS, maxWidth: THUMBNAIL_MAX_WIDTH }`, `helpRequest: null` (Task 2 to'ldiradi).

- [ ] **Step 1: Failing testlar:**
  - `help.clear follows command.issue`: egasi teacher → allow; boshqa teacher, it_support va student → deny; site admin → allow.
  - `help request clear reason is one of four`.
  - `heartbeat tells a lesson device to send thumbnails`: darsda `thumbnails` = `{ intervalMs: 1000, maxWidth: 480 }`; darsdan tashqarida `lesson: null`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test`, `pnpm typecheck` → 0.
- [ ] **Step 5:** Commit `feat(contracts): help requests and thumbnail directive`.

### Task 2: Help requests (server)

**Files:**
- Create: `apps/api/src/modules/help-requests/{help-requests.module.ts,help-requests.service.ts,help-requests.controller.ts,device-help.controller.ts}`, `apps/api/drizzle/0009_*.sql` (drizzle-kit generate; qo'lda tahrirlanmaydi)
- Modify: `apps/api/src/db/schema.ts`, `apps/api/test/support/db.ts` (`TABLES`), `apps/api/src/app.ts`, `apps/api/src/modules/events/{event-log.ts,events.service.ts}`, `apps/api/src/modules/devices/presence.service.ts`, `apps/api/src/modules/lessons/lessons.service.ts` (`endLesson`), `apps/api/src/modules/devices/devices.service.ts` (`#leaveLesson`)
- Test: `apps/api/test/help-requests.test.ts`, `apps/api/test/db-invariants.test.ts`, `apps/api/test/concurrency.pg.test.ts`

**Interfaces:**
- `help_requests` jadvali:
  - Ustunlar: `id uuid pk`, `organization_id`, `site_id`, `room_id`, `lesson_id`, `device_id`, `raised_at`, `cleared_at null`, `clear_reason null` (check: 4 sabab), `cleared_by uuid null`.
  - FK: `(site_id, lesson_id)` → `lessons(site_id, id)`, `(site_id, device_id)` → `devices(site_id, id)`.
  - Check: `(cleared_at is null) = (clear_reason is null)`.
  - Partial unique: `(lesson_id, device_id) where cleared_at is null`.
- Marshrutlar:
  - `POST /api/v1/device/help-request`: imzolangan, body `{}`, 200 `HelpRequest`. Ochiq so'rov bo'lsa o'shani qaytaradi, yangi event yozilmaydi. Faol dars a'zosi bo'lmasa 409 `conflict`.
  - `DELETE /api/v1/device/help-request`: imzolangan, 204; so'rov bo'lmasa no-op.
  - `DELETE /api/v1/help-requests/{helpRequestId}`: sessiya, `help.clear`, 204. Allaqachon yopilgan bo'lsa no-op; begona yoki noma'lum ID → audited 403. `Idempotency-Key` talab qilinmaydi (`DELETE /remote-sessions/{id}` kabi).

```typescript
@Injectable() export class HelpRequestsService {
  raise(device: AuthenticatedDevice): Promise<HelpRequest>;
  withdraw(device: AuthenticatedDevice): Promise<void>;
  clear(ctx: RequestContext, helpRequestId: string): Promise<void>;
  // Chaqiruvchining tranzaksiyasida, xona voqeasidan OLDIN (ADR 0008 lock tartibi):
  clearOpen(tx: Db, scope: { lessonId: string; deviceId?: string }, reason: 'lesson_ended' | 'device_left', clearedBy: string | null): Promise<number>;
  openOfLesson(db: Db, lessonId: string): Promise<HelpRequest[]>;
  openOfDevice(db: Db, lessonId: string, deviceId: string): Promise<{ id: string; raisedAt: string } | null>;
}
```

- `raise`: tranzaksiyada dars `FOR SHARE` va a'zolik qatori `FOR SHARE` olinadi, keyin `INSERT … ON CONFLICT DO NOTHING` va mavjud qator o'qiladi. Har o'zgarishda `EventLog.append` (`data`: `helpRequestId`, `deviceId`, yopilishda `reason`) va outbox `notify.rooms`, `commands.service` naqshi bilan.
- `clearOpen` chaqiriladigan joylar: `endLesson` (teacher, admin, maintenance `timeout`) va `#leaveLesson`. Ikkalasida `closeRemoteSessions` bilan yonma-yon.
- Heartbeat `lesson.helpRequest` = `openOfDevice`. Snapshot `helpRequests` = `openOfLesson`.

- [ ] **Step 1: Failing testlar:**
  - `a lesson device raises help once`: ikki POST → bir xil id, bitta `help_request.raised`, heartbeat'da shu id.
  - `raising help outside an active lesson is a conflict`.
  - `the lesson owner clears help and the device sees it on the next heartbeat`: ikkinchi DELETE → 204 va yangi event yo'q.
  - `another teacher cannot clear help`: 403 audit bilan; noma'lum UUID ham xuddi shu 403.
  - `the device withdraws its own help`: sabab `device`.
  - `ending the lesson clears open help`: teacher va maintenance timeout; sabab `lesson_ended`.
  - `a device leaving the lesson clears its help`: xonadan ko'chirish → `device_left`.
  - `snapshot lists open help requests`.
  - db-invariants: `one open help request per device in a lesson`, `help request clear reason and timestamp go together`.
  - concurrency.pg: `raising help while the lesson ends leaves no open request`: parallel `raise` + `endLesson` × 20, oxirida ochiq qator 0; `raise` yo 200 (keyin yopilgan), yo 409.
- [ ] **Step 2:** → FAIL. **Step 3:** Sxema + `drizzle-kit generate` + implement. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): help requests from lesson devices`.

### Task 3: Miniatura qabul qilish (WS) va oxirgi kadr ombori

**Files:**
- Create: `apps/api/src/modules/devices/device-verifier.ts`, `apps/api/src/modules/thumbnails/{thumbnails.module.ts,thumbnail-store.ts,thumbnail-ingest.ts}`
- Modify: `apps/api/src/modules/devices/device-auth.guard.ts` (verifier'ga delegatsiya), `apps/api/src/modules/devices/devices.module.ts`, `apps/api/src/app.ts`
- Test: `apps/api/test/thumbnails.test.ts`, `apps/api/test/device-auth.test.ts` (o'zgarmasdan yashil)

**Interfaces:**

```typescript
// device-verifier.ts — guard va WS upgrade uchun bitta qoida (ADR 0005); har xato ApiError('unauthenticated')
@Injectable() export class DeviceVerifier {
  verify(method: string, pathWithQuery: string, headers: IncomingHttpHeaders, rawBody: Buffer): Promise<AuthenticatedDevice>;
}
// thumbnail-store.ts — faqat xotira; CLOCK bilan
@Injectable() export class ThumbnailStore {
  put(deviceId: string, lessonId: string, jpeg: Buffer): 'stored' | 'too_fast' | 'not_jpeg';
  latest(deviceId: string, lessonId: string): { jpeg: Buffer; seq: number; at: number } | null; // TTL tashqarisida yoki boshqa dars → null
  sweep(): void; // TTL'dan eski yozuvlarni o'chiradi (har 10 s)
}
// thumbnail-ingest.ts — onApplicationBootstrap: HttpAdapterHost server'ining 'upgrade' hodisasi
@Injectable() export class ThumbnailIngest { onApplicationBootstrap(): void; onModuleDestroy(): Promise<void>; }
```

- Upgrade faqat `GET /api/v1/device/thumbnails` uchun. Imzo `GET`, `req.url` va bo'sh body bo'yicha tekshiriladi. Boshqa yo'l → 400 va soket yopiladi.
- Upgrade javoblari:
  - imzo xato → 401;
  - qurilma faol dars a'zosi emas → 409;
  - aks holda `ws` (`maxPayload: THUMBNAIL_MAX_BYTES`), soket ochilgan paytdagi `lessonId` bilan bog'lanadi.
- Kadr qoidalari:
  - text frame → close 1003;
  - JPEG SOI (`FF D8 FF`) bo'lmasa → tashlanadi;
  - `THUMBNAIL_SERVER_MIN_INTERVAL_MS` dan tez → tashlanadi;
  - hajm oshsa → `ws` 1009 bilan yopadi.
- Soketlar:
  - Bitta qurilmada bitta soket: yangisi eskisini 4000 `replaced` bilan yopadi.
  - Kadr kelganda oxirgi tekshiruvdan 5 s o'tgan bo'lsa a'zolik qayta tekshiriladi. A'zo bo'lmasa close 4409 `left_lesson`, kadr saqlanmaydi.
  - Ping har 30 s; javob bermagan soket uziladi.

- [ ] **Step 1: Failing testlar:** `ws` klient, `ca: app.ca`, test support'dagi imzo sarlavhalari bilan.
  - `a lesson device streams frames and only the latest is kept`.
  - `an unsigned, replayed or retired-device upgrade is refused with 401`.
  - `a device outside an active lesson cannot open the stream` (409).
  - `frames faster than the minimum interval are dropped`.
  - `oversized frames close the stream and non-JPEG frames are ignored`.
  - `a second stream from the same device replaces the first`.
  - `the stream closes once the device has left the lesson`: ko'chirish, `now + 5 s`, kadr → 4409.
  - `frames leave no trace in the database`: `events`, `outbox`, `audit_events` sonlari o'zgarmaydi.
  - Mavjud `device-auth.test.ts` yashil qoladi.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(api): ingest lesson thumbnails over a signed device socket`.

### Task 4: Teacher uchun oxirgi kadr

**Files:**
- Create: `apps/api/src/modules/thumbnails/thumbnails.controller.ts`
- Test: `apps/api/test/thumbnails.test.ts`

**Interfaces:**
- `GET /api/v1/lessons/{lessonId}/devices/{deviceId}/thumbnail` — `remote.view` darsga (egasi teacher yoki admin, `lessonTarget`). Qurilma darsning faol a'zosi bo'lishi shart, aks holda audited 403; noma'lum ID ham xuddi shu 403.
- Javob: 200, `content-type: image/jpeg`, `cache-control: no-store`, `x-ns-frame-seq`, `x-ns-frame-at` (ISO).
- Yangi kadr yo'q (TTL tashqarisida yoki boshqa dars) → 404 `not_found`. Muvaffaqiyatli o'qish audit qilinmaydi.
- Teacher setkasi uchun WS fan-out — P1f.

- [ ] **Step 1: Failing testlar:**
  - `the lesson owner reads the latest frame`: body oxirgi yuborilgan kadrga teng.
  - `a frame from a previous lesson is never served in the next one`: dars tugaydi, shu xonada yangi dars → 404.
  - `frames older than ten seconds are not served`.
  - `another teacher or it_support cannot read thumbnails`: 403 audit bilan.
  - `a device that is not in the lesson has no thumbnail`: 403.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(api): serve the latest lesson thumbnail to the lesson owner`.

### Task 5: Companion paketi, qurilma kaliti va imzo

**Files:**
- Create: `apps/companion/{package.json,tsconfig.json}`, `apps/companion/src/core/{identity.ts,machine-store.ts}`
- Modify: `pnpm-workspace.yaml` (`allowBuilds: electron: true`), `pnpm-lock.yaml`
- Test: `apps/companion/test/{identity.test.ts,machine-store.test.ts}`

**Interfaces:**
- `package.json`:
  - `name: @netschool/companion`, `type: module`.
  - dependencies: `@netschool/contracts`, `@netschool/domain` (workspace), `ws`, `zod`.
  - devDependencies: `electron: 45.2.1` (aniq), `esbuild`.
- `tsconfig.json`: base'dan; `lib: ["ES2023", "DOM"]`; `experimentalDecorators: true` — testlar `apps/api` manbasini import qiladi (tests/contracts kabi nisbiy yo'l bilan).

```typescript
// identity.ts
export interface DeviceIdentity { deviceId: string; publicKey: string; privateKey: KeyObject } // publicKey: SPKI DER base64url
export function generateDeviceKey(): { publicKey: string; privateKeyPem: string };
export function claimProof(privateKey: KeyObject, token: string, publicKey: string): string;
export type SignedHeaders = Record<'x-ns-device-id' | 'x-ns-timestamp' | 'x-ns-signature', string>;
export class RequestSigner {
  constructor(identity: DeviceIdentity, now?: () => number);
  sign(method: string, pathWithQuery: string, rawBody: Buffer): SignedHeaders;
  setClockOffset(ms: number): void;
}
// machine-store.ts
export interface DeviceConfig { hubOrigin: string; deviceId: string; siteId: string; publicKey: string; enrolledAt: string }
export interface Enrollment { config: DeviceConfig; identity: DeviceIdentity; ca: string | null }
export function machineDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string;
export function loadEnrollment(dir: string): Enrollment | null; // yo'q → null; buzilgan yoki kalit mos emas → Error
export function saveEnrollment(dir: string, e: { config: DeviceConfig; privateKeyPem: string; ca: string | null }): void; // har fayl tmp + rename; Global Constraints rejimlari
```

- [ ] **Step 1: Failing testlar:**
  - `claim proof verifies with the hub's verifyClaimProof` va `request signature verifies with the hub's deviceSigningInput`: `apps/api/src/modules/devices/device-keys.ts` dan import.
  - `public key is canonical SPKI the hub accepts` (`parseDevicePublicKey` ≠ null).
  - `signed timestamps strictly increase within one millisecond`.
  - `clock offset shifts signed timestamps`.
  - `machine dir per platform with env override`.
  - `enrollment round-trips and a mismatched key is rejected`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm install`, `pnpm typecheck` → 0.
- [ ] **Step 5:** Commit `feat(companion): device key, request signing and machine store`.

### Task 6: Hub klienti, capability hisoboti va `enroll` CLI

**Files:**
- Create: `apps/companion/src/core/{hub-client.ts,capabilities.ts,enroll.ts}`, `apps/companion/src/cli/enroll.ts`, `apps/companion/scripts/build.mjs` (hozircha `dist/enroll.mjs`)
- Modify: `apps/companion/package.json` (`build`, `enroll` skriptlari)
- Test: `apps/companion/test/{hub-client.test.ts,capabilities.test.ts,enroll.test.ts}`

**Interfaces:**

```typescript
// hub-client.ts
export type HubErrorKind = 'tls' | 'network' | 'timeout' | 'http';
export class HubError extends Error { kind: HubErrorKind; status: number | null; code: string | null }
export class HubClient {
  constructor(opts: { origin: string; ca: string | null; signer: RequestSigner | null }); // https bo'lmasa Error
  readonly origin: string;
  readonly agent: https.Agent; // WS ham shu agent/CA bilan
  json<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, schema: z.ZodType<T> | null,
    opts?: { lane?: 'control' | 'poll'; timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
  close(): void;
}
// capabilities.ts
export interface PlatformFacts { platform: NodeJS.Platform; arch: string; sessionType: 'x11' | 'wayland' | null; screenAccess: 'granted' | 'denied' | 'not-determined' | 'unknown' }
export function capabilityReport(f: PlatformFacts): CapabilityReport;
// enroll.ts
export async function enroll(input: { hubOrigin: string; token: string; ca: string | null; hostname: string; facts: PlatformFacts; dir: string; force?: boolean }): Promise<DeviceConfig>;
// cli/enroll.ts — exit: 0 ok, 2 usage, 3 hub/TLS, 4 rad etildi yoki allaqachon ro'yxatdan o'tgan
export async function runEnrollCli(argv: string[], env: NodeJS.ProcessEnv, io: { out(s: string): void; err(s: string): void }): Promise<number>;
```

- `HubClient`:
  - `node:https`; `ca` berilsa faqat u.
  - `control` lane ketma-ket (bir paytda bitta so'rov); `poll` lane alohida.
  - Timeout: default 10 s; long-poll uchun `wait + 10 s`.
  - 401: `Date` farqi > 5 s bo'lsa `setClockOffset`; 50 ms dan keyin bir marta qayta imzolash; yana 401 → `HubError(http, 401, 'unauthenticated')`.
  - TLS xatolari (`CERT_*`, `ERR_TLS_*`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) → `kind: 'tls'`.
- CLI:
  - Argumentlar: `--hub <origin> [--ca <pem fayl>] [--force]`; token `--token` yoki `NETSCHOOL_ENROLL_TOKEN`.
  - Token hech qachon chiqarilmaydi; muvaffaqiyatda `deviceId` chiqadi.
  - `enroll` avval claim qiladi, faylni faqat muvaffaqiyatdan keyin yozadi.
  - CLI Electron'siz `node` (yoki `ELECTRON_RUN_AS_NODE=1`) bilan ishlaydi; `screenAccess: 'unknown'`.

- [ ] **Step 1: Failing testlar:**
  - hub-client (lokal https server, `makeCert`):
    - `refuses a hub certificate signed by another CA`;
    - `refuses a certificate issued for another hostname`;
    - `refuses a plain http origin`;
    - `a skewed device clock is corrected from the hub Date header` (server `ts`ni ±30 s bilan tekshiradi; `now = Date.now() − 120 s`);
    - `re-signs once after a reordering 401 and then gives up`;
    - `control lane sends one request at a time`;
    - `a long poll does not block control requests`.
  - capabilities:
    - `macOS without screen access requires permission for thumbnails`;
    - `Wayland thumbnails are unsupported`;
    - `Windows reports every classroom capability available`;
    - `overlay is reported as soft`;
    - `every report passes the contracts schema`.
  - enroll (`startTestApp`, admin enrollment yaratadi):
    - `enrolls and the saved identity can heartbeat`;
    - `a used or unknown token is rejected and nothing is written`;
    - `an untrusted hub certificate fails before anything is written`;
    - `refuses to overwrite an existing enrollment without --force`;
    - `the CLI never prints the token`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm --filter @netschool/companion build` → `dist/enroll.mjs`.
- [ ] **Step 5:** Commit `feat(companion): fail-closed hub client and admin enrollment`.

### Task 7: SQLite holat cache va overlay lease

**Files:**
- Create: `apps/companion/src/core/{cache.ts,overlay.ts,clock.ts}`
- Test: `apps/companion/test/{cache.test.ts,overlay.test.ts}`

**Interfaces:**

```typescript
// clock.ts
export interface MonotonicClock { nowMs(): number; uptimeMs(): number; bootTimeMs(): number }
export const systemClock: MonotonicClock; // performance.now, os.uptime()*1000, Date.now() − uptime
// cache.ts — node:sqlite DatabaseSync; ':memory:' testlar uchun; WAL
export interface PersistedOverlay { lessonId: string; locked: boolean; sequence: string | null; message: string | null; bootTimeMs: number; deadlineUptimeMs: number }
export type CommandOutcome = { status: 'succeeded' } | { status: 'failed'; reason: 'unsupported' | 'permission_required' | 'error' };
export class StateCache {
  static open(file: string): StateCache;
  outcomeOf(commandId: string): CommandOutcome | null;
  recordOutcome(commandId: string, outcome: CommandOutcome, at: number): void; // oxirgi 1000 ta va 24 soat saqlanadi
  saveOverlay(s: PersistedOverlay | null): void;
  loadOverlay(): PersistedOverlay | null;
  close(): void;
}
// overlay.ts
export interface OverlayView { locked: boolean; message: string | null; lessonId: string | null }
export class OverlayController {
  constructor(clock: MonotonicClock, cache: StateCache, onChange: (v: OverlayView) => void);
  restore(): void;
  applyHeartbeat(lesson: HeartbeatLesson | null): void; // null → darhol ochiladi, cache tozalanadi
  applyCommand(c: { type: 'overlay.lock' | 'overlay.unlock'; sequence: string; lessonId: string; message?: string }): 'applied' | 'stale';
  tick(): void; // har 1 s; lease tugasa ochiladi
  view(): OverlayView;
}
```

- Lease va sequence:
  - Lease `leaseSeconds` dan hisoblanadi; buyruq bilan kelgan lock ham 120 s lease oladi, heartbeat uni yangilaydi.
  - `sequence: null` = −1. Eskiroq sequence'li heartbeat holatni ham, lease'ni ham o'zgartirmaydi.
- Cache'ga yozish: har o'zgarishda `PersistedOverlay` va `deadlineUptimeMs = uptimeMs + qolgan lease`.
- `restore()`:
  - boot boshqa yoki deadline o'tgan → cache tozalanadi;
  - aks holda lock deadline'gacha qo'llanadi (xabar bilan).

- [ ] **Step 1: Failing testlar** (soxta `MonotonicClock`):
  - `heartbeat lock holds only within the lease`;
  - `server silence releases the overlay after 120 seconds`;
  - `older sequence never overrides a newer one`;
  - `a wall-clock jump does not extend the lease` (`vi.setSystemTime` ±1 soat, monoton qiymat o'zgarmaydi);
  - `restart within the same boot restores the remaining lease`;
  - `reboot discards the cached lock`;
  - `lesson ending unlocks immediately`;
  - cache: `outcomes survive reopen`, `old outcomes are pruned`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(companion): overlay lease on a monotonic clock with a sqlite cache`.

### Task 8: Miniatura yuklovchi

**Files:**
- Create: `apps/companion/src/core/thumbnails.ts`
- Test: `apps/companion/test/thumbnails.test.ts`

**Interfaces:**

```typescript
export interface FrameSource { capture(maxWidth: number): Promise<Buffer | null> } // JPEG yoki null (ruxsat yo'q / bo'sh)
export interface ThumbnailSocket { readonly readyState: number; readonly bufferedAmount: number; send(b: Buffer): void; close(code?: number): void;
  on(e: 'open' | 'close' | 'error', l: (...a: unknown[]) => void): void }
export type ConnectSocket = (url: string, headers: SignedHeaders, agent: https.Agent) => ThumbnailSocket; // default: ws
export class ThumbnailUploader {
  constructor(deps: { hub: HubClient; signer: RequestSigner; source: FrameSource; connect?: ConnectSocket });
  start(directive: { intervalMs: number; maxWidth: number }): void; // idempotent; interval ≥ THUMBNAIL_CLIENT_MIN_INTERVAL_MS
  stop(): void;
  readonly streaming: boolean;
}
```

- Har tick'da soket ochiq va `bufferedAmount === 0` bo'lsagina capture va yuborish bo'ladi, aks holda tick o'tkazib yuboriladi (navbat yo'q).
- `null` yoki `THUMBNAIL_MAX_BYTES` dan katta kadr yuborilmaydi.
- Uzilsa backoff 1 s → 30 s bilan qayta ulanadi. Close 4409 → keyingi `start()` gacha kutadi.
- Kadr diskka yozilmaydi.

- [ ] **Step 1: Failing testlar:**
  - `frames reach the hub and the owner reads the latest` (`startTestApp`, soxta `FrameSource` kichik JPEG beradi, Task 4 endpoint'i);
  - `null frames from the source are not sent`;
  - `no capture while the previous frame is still buffered` (soxta `ConnectSocket`);
  - `the interval never drops below 500 ms`;
  - `stop closes the stream and capture ends`;
  - `after a left_lesson close the uploader waits for the next start`;
  - `reconnects after the hub drops the socket`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(companion): stream lesson thumbnails with backpressure`.

### Task 9: Buyruqlar, heartbeat va agent

**Files:**
- Create: `apps/companion/src/core/{commands.ts,agent.ts}`
- Test: `apps/companion/test/{commands.test.ts,agent.test.ts}`

**Interfaces:**

```typescript
// commands.ts
export interface CommandUi { showMessage(text: string): void }
export class CommandProcessor {
  constructor(deps: { hub: HubClient; cache: StateCache; overlay: OverlayController; ui: CommandUi });
  handleBatch(cmds: DeviceCommand[]): Promise<void>; // sequence (BigInt) bo'yicha tartiblab
}
// agent.ts
export type HubState = 'connecting' | 'online' | 'offline' | 'tls_error' | 'rejected';
export interface AgentStatus {
  hub: HubState; lastSeenAt: number | null; lessonId: string | null; overlay: OverlayView;
  help: { id: string; raisedAt: string } | null; thumbnails: 'off' | 'on' | 'requires_permission' | 'unsupported';
}
export interface AgentOptions { heartbeatMs?: number; pollWaitSeconds?: number; capabilityCheckMs?: number; overlayTickMs?: number } // 10_000, 25, 30_000, 1_000
export class CompanionAgent {
  constructor(deps: { hub: HubClient; cache: StateCache; overlay: OverlayController; commands: CommandProcessor;
    thumbnails: ThumbnailUploader | null; facts: () => Promise<PlatformFacts>; onStatus: (s: AgentStatus) => void }, opts?: AgentOptions);
  start(): Promise<void>;
  raiseHelp(): Promise<void>;
  withdrawHelp(): Promise<void>;
  stop(): Promise<void>;
}
```

- `CommandProcessor`:
  - Saqlangan `outcomeOf` bor → faqat o'sha receipt qayta yuboriladi, qayta bajarilmaydi. Aks holda `acknowledged` → bajarish → `recordOutcome` → yakuniy receipt.
  - `message.show` → `ui.showMessage` → `succeeded`.
  - `overlay.*` → `applyCommand`. `stale` → `succeeded` (qurilma allaqachon yangiroq holatda).
  - Noto'g'ri payload → `failed/error`.
- Agent sikllari:
  - Startda `overlay.restore()`, keyin capability `PUT`.
  - Heartbeat → `overlay.applyHeartbeat`; status `help` va `thumbnails` heartbeat'dan.
  - Long-poll (`poll` lane) → `handleBatch`.
  - Xatoda backoff 1 s → 30 s. `HubError.kind === 'tls'` → `tls_error`, qayta urinish davom etadi.
  - Ikki marta ketma-ket 401 → `rejected`: sikllar to'xtaydi, heartbeat har 60 s.
- Miniatura: `lesson.thumbnails` bor va capability `available` → `thumbnails.start(directive)`; aks holda `stop()`.

- [ ] **Step 1: Failing testlar:**
  - commands (yozib oluvchi soxta hub):
    - `a redelivered command is not executed twice`;
    - `commands run in sequence order`;
    - `a stale overlay command is reported succeeded without changing the overlay`;
    - `a malformed payload fails with error`.
  - agent (`startTestApp`, `heartbeatMs: 50`, `pollWaitSeconds: 1`, real taymerlar):
    - `a teacher lock shows the overlay and the target succeeds`;
    - `an unlock issued while the device was offline applies from the first heartbeat`;
    - `the overlay falls when the hub stops answering`: `app.close()`, soxta monoton +120 001 ms; status `offline`, `lastSeenAt` bor;
    - `a TLS failure shows tls_error and keeps retrying`;
    - `help raised on the device shows in the room snapshot and a teacher clear resets it`;
    - `capabilities are sent at start and again only when they change`;
    - `a retired device reports rejected and stops polling`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(companion): command handling, heartbeat and help in the agent`.

### Task 10: Electron qobig'i: oynalar, tray, capture, preload va lokal

**Files:**
- Create:
  - `apps/companion/src/main/{main.ts,windows.ts,tray.ts,capture.ts,platform.ts,ipc.ts,security.ts}`
  - `apps/companion/src/preload/preload.ts`
  - `apps/companion/src/renderer/{status.html,status.ts,overlay.html,overlay.ts,message.html,message.ts,styles.css}`
  - `apps/companion/src/core/i18n.ts`
- Modify: `apps/companion/scripts/build.mjs` (`dist/main.mjs` ESM, `external: electron`; `dist/preload.cjs` CJS bundle; renderer → `dist/renderer/`), `apps/companion/package.json` (`main: dist/main.mjs`, `start: electron .`)
- Test: `apps/companion/test/{security.test.ts,i18n.test.ts,ipc.test.ts}`

**Interfaces:**

```typescript
// security.ts
export function windowPreferences(preload: string): Electron.WebPreferences; // sandbox, contextIsolation, nodeIntegration:false, webviewTag:false, spellcheck:false
export function hardenSession(s: Electron.Session): void; // permission request/check → false; faqat file: so'rovlari
export function hardenContents(c: Electron.WebContents): void; // will-navigate preventDefault; setWindowOpenHandler deny
// ipc.ts
export function isTrustedSender(frameUrl: string, rendererRoot: string): boolean;
// preload → window.netschool
export interface NetschoolBridge {
  onStatus(cb: (s: AgentStatus) => void): () => void; // 'status:update'
  raiseHelp(): Promise<void>;                          // invoke 'help:raise'
  withdrawHelp(): Promise<void>;                       // invoke 'help:withdraw'
  dismissMessage(id: string): void;                    // send 'message:dismiss' (zod: uuid)
  strings(): Promise<Record<StringKey, string>>;       // invoke 'i18n:strings'
}
// i18n.ts
export type Locale = 'uz' | 'ru' | 'en';
export type StringKey = keyof typeof uz; // `uz` lug'ati kalitlar manbai; ru/en shu kalitlarning hammasini beradi
export function pickLocale(appLocale: string): Locale; // 'ru*' → ru, 'en*' → en, boshqasi → uz
export const strings: Record<Locale, Record<StringKey, string>>;
// capture.ts
export class ElectronFrameSource implements FrameSource {} // desktopCapturer 'screen', primary display, isEmpty() → null, toJPEG(60)
// platform.ts
export async function platformFacts(): Promise<PlatformFacts>; // darwin: systemPreferences.getMediaAccessStatus('screen'); linux: XDG_SESSION_TYPE
```

- `main.ts`:
  - Single-instance lock; `NETSCHOOL_COMPANION_STATE_DIR` bo'lsa `app.setPath('userData', …)`.
  - `loadEnrollment(machineDir(...))`. `null` → status oynasi «Kompyuter ro'yxatdan o'tmagan — IT xizmatiga murojaat qiling», agent ishga tushmaydi.
  - Aks holda `StateCache` → `OverlayController` → agent; `onStatus` → tray va barcha oynalarga.
- Oynalar:
  - overlay: har displeyda bitta, `alwaysOnTop: 'screen-saver'`, `frame: false`, `skipTaskbar`, `closable: false`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.
  - message: kichik, always-on-top, 30 s yoki «OK».
  - status: tray menyusidan.
- IPC handler'lari `isTrustedSender`ni tekshiradi, argumentlarni zod bilan validatsiya qiladi.
- Asosiy uz matnlar (ru/en tarjimasini implementer yozadi):
  - overlay sarlavhasi: «Ekran o'qituvchi tomonidan vaqtincha qulflangan»;
  - overlay izohi: «Yumshoq bloklash — dars davom etmoqda»;
  - help tugmalari: «Yordam so'rash» / «So'rovni bekor qilish»;
  - miniatura indikatori: «O'qituvchi ekraningiz miniaturasini ko'ryapti»;
  - hub holatlari: «Ulangan», «Ulanmoqda…», «Hub bilan aloqa yo'q (oxirgi aloqa: …)», «Xavfsiz ulanish tekshiruvidan o'tmadi», «Qurilma hub tomonidan rad etildi».

- [ ] **Step 1: Failing testlar:**
  - `renderer windows are sandboxed without Node`;
  - `every locale has every key`;
  - `ru-RU picks ru and unknown locales fall back to uz`;
  - `ipc rejects calls from frames outside the app`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm --filter @netschool/companion build`, `pnpm typecheck`, `pnpm lint` → 0.
- [ ] **Step 5:** Commit `feat(companion): electron shell with sandboxed overlay, status and help`.

### Task 11: E2E smoke (haqiqiy Electron) va CI

**Files:**
- Create: `apps/companion/e2e/{harness.ts,companion.e2e.ts}`
- Modify: `vitest.config.ts` (project `companion-e2e`: `apps/companion/e2e/**/*.e2e.ts`, `testTimeout: 60_000`, `fileParallelism: false`), root `package.json` (`test:e2e:companion`), `.github/workflows/ci.yml`

**Interfaces:**
- `harness.ts`:
  - `startTestApp` (PGlite); org, admin, teacher va xona seed qilinadi.
  - Admin enrollment yaratadi → `runEnrollCli` tmp katalogga (`--ca` = `app.ca`).
  - `_electron.launch({ args: ['apps/companion/dist/main.mjs'], env: { NETSCHOOL_COMPANION_DIR, NETSCHOOL_COMPANION_STATE_DIR } })`.
- CI job `companion-e2e` (ubuntu-latest):
  - `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (Chromium sandbox real qoladi; `--no-sandbox` hech qachon ishlatilmaydi);
  - `pnpm install --frozen-lockfile`;
  - `pnpm --filter @netschool/companion build`;
  - `xvfb-run -a pnpm test:e2e:companion`.
- `unit`, `contract`, `compose-smoke` job'lariga `ELECTRON_SKIP_BINARY_DOWNLOAD: 1`. Api Docker image'iga ta'sir yo'q (`--filter @netschool/api...`).

- [ ] **Step 1: Failing testlar** (bitta ishga tushirilgan ilova, ketma-ket):
  - `renderers are sandboxed and pages have no Node`: main'da `getLastWebPreferences()`; sahifada `typeof require`/`process` → `undefined`.
  - `a teacher lock covers the screen and unlock removes it`.
  - `a teacher message is shown to the student`.
  - `the help button raises help for the teacher` (room snapshot'da).
  - `relaunching while locked restores the overlay` — oxirgi test: lock → `electronApp.close()` → hub (`app.close()`) to'xtatiladi → qayta launch. Heartbeat muvaffaqiyatsiz bo'lsa ham overlay cache'dan ko'rinadi, status `offline`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** Lokal (macOS) `pnpm --filter @netschool/companion build && pnpm test:e2e:companion` → PASS; push'dan keyin CI job yashil.
- [ ] **Step 5:** Commit `test(companion): electron smoke against the hub in CI`.

### Task 12: Hujjatlar

**Files:**
- Create: `docs/adr/0009-companion.md`, `apps/companion/README.md`
- Modify:
  - `docs/superpowers/plans/2026-10-27-netschool-roadmap.md`: P1e holati.
  - `docs/adr/0005-devices-enrollment.md`, `docs/adr/0006-lessons-commands.md`: «Companion klienti — P1e» → havola.

**ADR 0009 mazmuni:**
- Qarorlar:
  - mashina kaliti va `enroll`;
  - fail-closed TLS va `hub-ca.pem`;
  - soat offset'i `Date` sarlavhasidan;
  - buyruqlar long-poll'da qoladi, WS faqat miniaturalar uchun;
  - overlay lease: monoton taymer + boot tekshiruvi;
  - help matnsiz;
  - capability kalitlari;
  - miniatura qoidalari va dars bo'yicha bog'lanishi.
- Ma'lum cheklovlar:
  - kalitni P2d'gacha har OS user o'qiy oladi — faqat shu qurilma nomidan imzolash mumkin;
  - single instance faqat bitta OS user ichida; bir nechta sessiya bir vaqtda — P2d;
  - soft overlay'ni ilovani o'ldirish bilan chetlab o'tish mumkin; autostart va relaunch — P2e/P2d;
  - Wayland miniaturalari — P0c;
  - teacher setkasi uchun WS fan-out va fon tile'ida fps pasaytirish — P1f;
  - installer va imzolash — P2e;
  - miniatura ombori bitta API jarayonida.

**README:** dev'da ishga tushirish, `enroll` misoli, kataloglar, TLS xatolarini tekshirish.

- [ ] **Step 1:** Yozish. **Step 2:** `pnpm lint`, `pnpm test`, `pnpm typecheck` → 0.
- [ ] **Step 3:** Commit `docs: record companion decisions`.
