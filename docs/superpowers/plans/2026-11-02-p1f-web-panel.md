# P1f — O'qituvchi va IT admin veb-paneli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brauzerdagi `apps/web` paneli.
- **O'qituvchi:** o'z xonasini tanlaydi va dars boshlaydi. Sinf setkasida har kompyuterning jonli miniaturasi, holati va yordam so'rovi ko'rinadi. Hammaga yoki tanlanganlarga xabar, yumshoq bloklash va ochishni yuboradi, har qurilma natijasini ko'radi. Kompyuterni panel ichida ko'radi yoki boshqaradi (remote viewer) va darsni tugatadi.
- **IT admin:** P1h quvvat amallarini qurilma soni tasdig'i bilan yuboradi, natijalarni kuzatadi va haftalik jadvallarni boshqaradi.
- Tillar: uz/ru/en.

**Architecture:**
- SPA'ni API o'z origin'idan (`PUBLIC_ORIGIN`) beradi: cookie `__Host-` va `SameSite=Strict`, Origin tekshiruvi aynan teng, CORS yo'q. Statik fayllar `WEB_DIST_DIR`dan, xavfsizlik headerlari bilan.
- Miniaturalar: o'qituvchi uchun bitta WS (`/api/v1/lessons/{id}/thumbnails/stream`), har qurilmaning oxirgi kadri ≤1 fps, sekin klientga kadr tashlanadi (§11). WS fan-out ADR 0009'da shu bosqichga qoldirilgan edi.
- Remote viewer gateway (8444) sahifasi iframe ichida ochiladi. Gateway `x-frame-options`ni olib tashlab `frame-ancestors <PUBLIC_ORIGIN>` beradi (ADR 0003). Sessiya lease'i (30 s) Web Worker taymeri bilan 10 s da yangilanadi: fon tabida asosiy oqim taymerlari sekinlashadi.
- Klient holati: events long-poll (`wait=25`, cursor, `resync`) va qurilmalar ro'yxati (10 s da so'rov, snapshot'da qurilmalar yo'q).

**Tech Stack:**
- Yangi dependency'lar (aniq pin): `react` 19.3.1, `react-dom` 19.3.1, `react-router` 8.5.1, `vite` 8.3.5, `@vitejs/plugin-react` 6.2.1.
- Test: `@testing-library/react` 16.3.3, `jsdom` 30.1.3. Playwright 1.64.1 allaqachon root'da.
- UI kutubxonasi yo'q (oddiy CSS). Server tomoni P1h bilan bir xil.

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md):
- §3: o'qituvchi paneli — sinf setkasi, dars boshqaruvi, buyruqlar va natijalar, remote viewer.
- §4: React + Vite.
- §11: latest-frame, backpressure, miniatura p95 ≤2 s.
- §13: same-site gateway.
- §15.1: P1 qabul mezonlari.

ADR'lar:
- [0003](../../adr/0003-session-gateway.md): iframe, frame-ancestors;
- [0006](../../adr/0006-lessons-commands.md): events, buyruqlar;
- [0008](../../adr/0008-remote-sessions.md): renew 10 s, fencing, `control_busy`;
- [0009](../../adr/0009-companion.md): WS fan-out P1f'da;
- [0010](../../adr/0010-power-management.md): quvvat API (P1h).

**Egasining qarorlari (2026-11-02):** P1f'ga IT admin quvvat sahifasi kiradi.

**Rejadagi qaror:** `apps/desktop` (Electron qobig'i) bu rejadan chiqarilgan. Panel brauzerda to'liq ishlaydi; desktop qobig'i alohida kichik reja bo'ladi (yo'l xaritasiga yoziladi).

**Shart:** P1h `main`ga merge qilingan (power API shu rejada ishlatiladi).

## Global Constraints

- P1a–P1h Global Constraints amal qiladi. Server o'zgarishlari P1h qoidalarida: audit, bir xil 403, `@Inject`, zod, `vi.useFakeTimers` yo'q.
- `apps/web` faqat `@netschool/contracts` sxemalari va turlaridan foydalanadi. `domain`, `api`, Node modullari import qilinmaydi.
- **Hosting.** API `WEB_DIST_DIR` (ixtiyoriy env) berilsa, `/api/` va `/healthz`dan boshqa GET so'rovlarga SPA beradi. Fayl bo'lmasa `index.html`. Headerlar:
  - `index.html`: `cache-control: no-store`.
  - `assets/*`: `cache-control: public, max-age=31536000, immutable`.
  - Hammasiga:
    - `content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src <GATEWAY_PUBLIC_ORIGIN yoki 'none'>; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`;
    - `x-content-type-options: nosniff`;
    - `referrer-policy: no-referrer`.
  - `connect-src 'self'` same-origin `wss:`ni ham qamraydi.
- **Klient so'rovlari:** `credentials: 'same-origin'`, JSON. Har o'zgartiruvchi amal (`POST lessons`, `POST commands`, `POST power-actions`, `POST power-schedules`, `POST remote-sessions`, `POST …/end`) bitta foydalanuvchi niyati uchun bitta `Idempotency-Key` (`crypto.randomUUID()`) ishlatadi. Tarmoq xatosidan keyingi qayta urinish o'sha kalit bilan.
- Xato `{ error: { code, message, correlationId } }` → foydalanuvchiga `code` bo'yicha tarjima va `correlationId`.
  - 401 → login sahifasi.
  - 403 `password_change_required` → parol sahifasi.
- **Miniatura stream:** `wss://<PUBLIC_ORIGIN>/api/v1/lessons/{lessonId}/thumbnails/stream`.
  - Shartlar: cookie sessiya, `Origin === PUBLIC_ORIGIN`, `remote.view` (dars egasi yoki admin).
  - Binary xabar: 16 bayt qurilma UUID (raw) + JPEG.
  - Har qurilma uchun ≤1 kadr / `THUMBNAIL_INTERVAL_MS`.
  - `bufferedAmount > THUMBNAIL_STREAM_MAX_BUFFER` (1 048 576) → kadr tashlanadi.
  - Har `THUMBNAIL_STREAM_RECHECK_MS` (30 000) da sessiya va dars qayta tekshiriladi. Close kodlari: `4401` sessiya tugagan yoki ruxsat olingan, `4410` dars tugagan.
- **Gateway:** javoblardan `x-frame-options` olib tashlanadi, `content-security-policy: frame-ancestors <PUBLIC_ORIGIN>` qo'shiladi (upstream CSP bo'lsa `frame-ancestors` direktivasi almashtiriladi).
- **i18n:** `uz` (default), `ru`, `en`. Kalitlar `uz` obyektidan tiplanadi (`Record<StringKey, string>`), API error kodlarining hammasi tarjimada bor. Til `localStorage['netschool.locale']`da.
- Brauzer testlari faqat headless Chromium'da va foydalanuvchi ekraniga chiqmaydi. TLS tekshiruvi o'chirilmaydi: test sertifikatining SPKI'si `--ignore-certificate-errors-spki-list` bilan pin qilinadi, `ignoreHTTPSErrors` ishlatilmaydi.

## Review Focus

1. **90 daqiqalik dars, 30 kompyuter, 1 fps** → brauzer xotirasi o'smaydi: har yangi kadr uchun eski `blob:` URL bo'shatiladi. → Task 5 `replacing a frame revokes the previous object URL`.
2. **Sekin Wi-Fi'dagi o'qituvchi noutbuki** → server bufer to'ldirmaydi, kadr tashlaydi, boshqa o'qituvchilarga ta'sir qilmaydi. → Task 2 `a slow viewer gets frames dropped, not buffered`.
3. **Sessiya dars o'rtasida tugaydi** (2 soat bo'sh turish) → panel login'ga o'tadi, WS `4401` bilan yopiladi; qayta kirgach o'sha dars ochiladi. → Task 2 `a revoked session closes the stream with 4401`; Task 4 `a 401 anywhere returns to login and back`.
4. **Events `resync`** (hub qayta ishga tushdi yoki cursor eskirdi) → holat snapshot'dan qayta quriladi, takroriy event ikki marta qo'llanmaydi. → Task 5 `a resync rebuilds state from the snapshot`, `a duplicate event after resync is ignored`.
5. **Ikki marta bosish yoki tarmoq qayta urinishi** ("Darsni boshlash", "O'chirish") → bitta dars yoki amal. Remote viewer fon tabida ham lease'ni yo'qotmaydi. → Task 4 `a retried intent reuses its idempotency key`; Task 6 `renewal keeps running while the tab is hidden`.

---

### Task 0: Branch

- [ ] **Step 1:** P1h merge qilinganini tekshirish: `git log main --oneline | rg "power"`. Bo'lmasa to'xta. Keyin `git switch main && git pull --ff-only && git switch -c p1f-web`. Rejani commit qilish: `docs: P1f web panel plan`.

### Task 1: API SPA'ni beradi

**Files:**
- Create: `apps/api/src/web/static-web.ts`
- Modify: `apps/api/src/config/config.ts` (`webDistDir?: string`, env `WEB_DIST_DIR`, `*_FILE` qoidasi), `apps/api/src/app.ts`, `apps/api/test/support/app.ts` (`webDistDir?` opsiyasi)
- Test: `apps/api/test/static-web.test.ts`, `apps/api/test/config.test.ts`

**Interfaces — Produces:** `mountStaticWeb(app: NestExpressApplication, opts: { dir: string; gatewayOrigin: string | null }): void` (express middleware, Nest marshrutlaridan oldin, faqat GET/HEAD).

- [ ] **Step 1: Failing testlar** (vaqtinchalik katalogda `index.html` va `assets/app-abc.js`):
  - `serves index.html for app routes with no-store and the CSP`;
  - `serves hashed assets as immutable`;
  - `api paths stay JSON 404 and are not swallowed by the SPA`;
  - `without WEB_DIST_DIR no static files are served`;
  - `frame-src names the gateway origin when configured`;
  - `path traversal outside the dist directory is refused` (`/..%2f..%2fetc/passwd` → index yoki 404, fayl berilmaydi).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement (`node:fs` + `express.static` `{ index: false, fallthrough: true }`, keyin fallback). **Step 4:** → PASS. **Step 5:** Commit `feat(api): serve the web panel with security headers`.

### Task 2: O'qituvchi uchun miniatura stream (WS fan-out)

**Files:**
- Create: `apps/api/src/common/upgrade-router.ts`, `apps/api/src/modules/thumbnails/thumbnail-stream.ts`
- Modify: `apps/api/src/modules/thumbnails/{thumbnail-ingest.ts,thumbnail-store.ts,thumbnails.module.ts}`, `packages/domain/src/thumbnails.ts` (`THUMBNAIL_STREAM_MAX_BUFFER`, `THUMBNAIL_STREAM_RECHECK_MS`)
- Test: `apps/api/test/thumbnail-stream.test.ts`, `apps/api/test/thumbnails.test.ts`

**Interfaces — Produces:**

```typescript
// upgrade-router.ts — HTTP server'dagi yagona 'upgrade' tinglovchisi; yo'l bo'yicha handler, mos kelmasa 404 va destroy
@Injectable() export class UpgradeRouter { route(pathname: string, handler: (req, socket, head) => void): () => void }
// thumbnail-store.ts
onFrame(listener: (deviceId: string, lessonId: string) => void): () => void;
```

- Ingest endi `UpgradeRouter` orqali `/api/v1/device/thumbnails`ni oladi. Hozir boshqa upgrade yo'llari 400 bilan yopiladi (ADR 0009 keyingi ishlar), endi mos kelmasa 404.
- Stream: upgrade'da cookie sessiya (`Sessions`/actor loader, `AuthGuard` mantiqi bilan bir xil), Origin va `remote.view` tekshiriladi; rad etilsa HTTP 401/403 va destroy. Ulangach dars a'zolarining mavjud oxirgi kadrlari darhol yuboriladi, keyin `onFrame` bo'yicha. Qurilma a'zoligi har recheck'da yangilanadi.

- [ ] **Step 1: Failing testlar** (`ws` klient, test sessiya cookie'si):
  - `the lesson owner receives frames tagged with the device id`;
  - `another teacher is refused and audited`;
  - `a wrong Origin is refused`;
  - `frames are sent at most once per interval per device`;
  - `a slow viewer gets frames dropped, not buffered` (`bufferedAmount`ni soxta socket bilan oshirish → `send` chaqirilmaydi);
  - `ending the lesson closes the stream with 4410`;
  - `a revoked session closes the stream with 4401` (logout → recheck; test uchun `recheckMs` injeksiya);
  - `an unknown upgrade path is closed with 404`;
  - `device thumbnail ingest still works through the router` (mavjud testlar).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm test` → PASS. **Step 5:** Commit `feat(api): live thumbnail stream for the lesson owner`.

### Task 3: Gateway iframe'ga ruxsat beradi

**Files:**
- Modify: `packages/session-gateway/src/headers.ts` (`sanitizeResponseHeaders(h, { frameAncestor })`), `packages/session-gateway/src/server.ts` (opsiya), `apps/api/src/modules/remote-sessions/remote-gateway.ts` (`publicOrigin`ni uzatish)
- Test: `packages/session-gateway/test/headers.test.ts`, `tests/contracts/viewer-browser.test.ts`

- [ ] **Step 1: Failing testlar:**
  - `x-frame-options is removed and frame-ancestors names the panel origin`;
  - `an upstream CSP keeps its directives but frame-ancestors is replaced`;
  - contract (real MeshCentral, headless): `the viewer loads inside an iframe on the panel origin`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** unit va `pnpm test:contract` → PASS. **Step 5:** Commit `feat(gateway): allow the viewer to be framed by the panel`.

### Task 4: `apps/web` asosi: build, API klient, i18n, kirish

**Files:**
- Create: `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html}`, `apps/web/src/{main.tsx,app.tsx,styles.css}`, `apps/web/src/api/{client.ts,intent.ts}`, `apps/web/src/i18n/{strings.ts,i18n.tsx}`, `apps/web/src/auth/{session.tsx,login-page.tsx,password-page.tsx,require-role.tsx}`, `apps/web/src/layout/shell.tsx`
- Modify: `pnpm-workspace.yaml` (agar kerak bo'lsa), `biome.json` (agar `apps/web` uchun JSX sozlamasi kerak bo'lsa)
- Test: `apps/web/test/{client.test.ts,i18n.test.ts,login.test.tsx,intent.test.ts}` (`// @vitest-environment jsdom`)

**Interfaces — Produces:**

```typescript
// api/client.ts
export class ApiFailure extends Error { readonly status: number; readonly code: string; readonly correlationId: string | null }
export interface Api {
  get<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T>;
  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, schema: ZodType<T> | null, opts?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<T>;
}
export function createApi(fetchImpl: typeof fetch, onUnauthenticated: () => void, onPasswordChange: () => void): Api;
// api/intent.ts — bitta niyat uchun bitta kalit; muvaffaqiyat yoki aniq (4xx) javobdan keyin yangilanadi
export function useIntent<T>(run: (key: string) => Promise<T>): { run: () => Promise<T>; pending: boolean; error: ApiFailure | null };
// i18n
export type Locale = 'uz' | 'ru' | 'en'; export type StringKey = keyof typeof uz;
export function useT(): (key: StringKey, vars?: Record<string, string | number>) => string;
// auth
export function useMe(): MeResponse; // contracts meResponseSchema
export function RequireRole(props: { anyOf: Role[]; children: ReactNode }): ReactNode;
```

- Marshrutlar: `/login`, `/password`, `/rooms` (o'qituvchi xonalari yoki admin site/xonalari), `/rooms/:roomId` (Task 5), `/power` (Task 7, faqat `school_admin`/`it_support`). `/` → roliga qarab.
- Paketlar `package.json`da aniq versiya bilan (Tech Stack).
- Vite dev server https'da ishlaydi. `/api` (ws ham) proxy orqali API'ga ketadi, `proxyReq`da `origin` headeri `PUBLIC_ORIGIN`ga o'rnatiladi; bu faqat dev uchun, README'da yoziladi.
- Root skriptlar: `build:web`, `test:e2e:web` (Task 8).

- [ ] **Step 1: Failing testlar:**
  - `error envelope becomes ApiFailure with code and correlationId`;
  - `a 401 anywhere returns to login and back` (`onUnauthenticated` + qaytish manzili saqlanadi);
  - `password_change_required routes to the password page`;
  - `a retried intent reuses its idempotency key` (1-urinish tarmoq xatosi, 2-urinish → bir xil kalit; muvaffaqiyatdan keyin yangi kalit);
  - `every locale has every key and every API error code`;
  - `login page submits credentials and shows the translated error`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm --filter @netschool/web build` → `dist/index.html`; `pnpm typecheck && pnpm lint` → PASS. **Step 5:** Commit `feat(web): app shell, API client, i18n and sign-in`.

### Task 5: Sinf sahifasi: dars, setka, buyruqlar, yordam

**Files:**
- Create: `apps/web/src/classroom/{room-page.tsx,lesson-state.ts,use-events.ts,use-devices.ts,thumbnail-feed.ts,device-grid.tsx,device-tile.tsx,command-bar.tsx,command-results.tsx}`, `apps/web/src/rooms/rooms-page.tsx`
- Test: `apps/web/test/{lesson-state.test.ts,thumbnail-feed.test.ts,room-page.test.tsx}`

**Interfaces — Produces:**

```typescript
// lesson-state.ts — sof reducer (React'siz)
export interface LessonState { cursor: string | null; lesson: Lesson | null; commands: Map<string, Command>; help: Map<string, HelpRequest>; remote: Map<string, RemoteSession>; lastSeq: number }
export function applyPage(state: LessonState, page: EventsResponse): LessonState; // resync → snapshot'dan; seq ≤ lastSeq → e'tiborsiz
// thumbnail-feed.ts — WS klient; kadr → blob URL, eskisi revoke
export class ThumbnailFeed { constructor(url: string, onFrame: (deviceId: string, objectUrl: string) => void, deps?: { WebSocket; URL }); close(): void }
```

- Sahifa: dars yo'q → "Darsni boshlash" (`title`, `durationMinutes`). Bor → setka:
  - Har plitka: hostname, Companion holati (`online/stale/never`), MeshAgent holati, miniatura, yordam belgisi (bosilsa `DELETE help-requests/{id}`), oxirgi buyruq natijasi.
  - Tanlash (checkbox) va buyruq paneli: xabar (≤500), bloklash (ixtiyoriy matn ≤200), ochish. Hammaga yoki tanlanganlarga.
  - Natijalar paneli: `command.target_updated` bo'yicha har qurilma holati, summary.
  - "Darsni tugatish" (tasdiq bilan).
- `use-events`: `GET /events?roomId&after&wait=25` sikli, `AbortController` bilan; xato → 1–30 s backoff.
- `use-devices`: `GET rooms/{id}/devices` har 10 s.
- WS URL: `location.origin.replace('https:', 'wss:') + '/api/v1/lessons/' + id + '/thumbnails/stream'`.
- Admin (`school_admin`) ham xonani ochib ko'ra oladi. Buyruq tugmalari faqat dars egasi yoki admin uchun (server baribir tekshiradi; UI 403'ni tarjima qiladi).

- [ ] **Step 1: Failing testlar:**
  - `a resync rebuilds state from the snapshot`;
  - `a duplicate event after resync is ignored`;
  - `command target updates fill the per-device results`;
  - `help raised and cleared events toggle the tile badge`;
  - `replacing a frame revokes the previous object URL` (soxta `URL.createObjectURL/revokeObjectURL` hisobi);
  - `frames for a device not in the lesson are ignored`;
  - room-page (soxta `Api`): `starting a lesson shows the grid`, `sending a message to selected devices posts their ids`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS. **Step 5:** Commit `feat(web): classroom grid, lesson control and commands`.

### Task 6: Remote viewer

**Files:**
- Create: `packages/remote-viewer/{package.json,tsconfig.json}`, `packages/remote-viewer/src/{index.ts,session-controller.ts,renew-worker.ts}`, `apps/web/src/classroom/remote-panel.tsx`
- Test: `packages/remote-viewer/test/session-controller.test.ts`, `apps/web/test/remote-panel.test.tsx`

**Interfaces — Produces:**

```typescript
export type ViewerState =
  | { kind: 'opening' }
  | { kind: 'open'; url: string; mode: 'view' | 'control'; session: RemoteSession }
  | { kind: 'closed'; reason: 'closed' | 'control_busy' | 'expired' | 'lesson_ended' | 'error'; code?: string };
export class RemoteSessionController {
  constructor(deps: { api: Api; timer: RenewTimer; idempotencyKey: () => string });
  open(lessonId: string, deviceId: string, mode: 'view' | 'control'): Promise<void>; // POST remote-sessions → POST ticket → iframe url
  close(): Promise<void>;                                                             // DELETE
  subscribe(listener: (s: ViewerState) => void): () => void;
}
export interface RenewTimer { start(everyMs: number, tick: () => void): void; stop(): void }
export function workerRenewTimer(): RenewTimer; // renew-worker.ts (module Worker, setInterval)
```

- Renew har `RENEW_INTERVAL_MS` (10 000) da, `fencing` bilan (control). Natijalar:
  - 409 yoki 404 → `closed: expired`;
  - session `status !== 'open'` → reason'ga mos `closed`.
- Iframe: `sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"`, `allow="clipboard-read; clipboard-write; fullscreen"`, `referrerpolicy="no-referrer"`.
- Panel yopilganda yoki sahifadan chiqilganda `close()` chaqiriladi (`pagehide`da `fetch(..., { keepalive: true })` bilan DELETE).

- [ ] **Step 1: Failing testlar:**
  - `open requests a session then a ticket and exposes the url`;
  - `control_busy closes with that reason`;
  - `renewal sends the fencing token every interval`;
  - `a failed renewal marks the session expired and stops the timer`;
  - `renewal keeps running while the tab is hidden` (worker timer soxtasi orqali: `document.hidden = true` asosiy taymerga ta'sir qilmaydi — controller `RenewTimer`dan boshqa taymer ishlatmasligi tekshiriladi);
  - `closing the panel deletes the session`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS. **Step 5:** Commit `feat(web): embedded remote viewer with lease renewal`.

### Task 7: IT admin: quvvat sahifasi

**Files:**
- Create: `apps/web/src/power/{power-page.tsx,scope-picker.tsx,confirm-dialog.tsx,action-list.tsx,action-detail.tsx,schedules.tsx}`
- Test: `apps/web/test/power-page.test.tsx`

**Consumes:** P1h API va `@netschool/contracts` `power.ts` sxemalari (ADR 0010).

- Ko'lam tanlash: butun universitet (faqat org admin) → binolar → xonalar → qurilmalar (`GET sites`, `GET sites/{id}/rooms`, `GET sites/{id}/devices`).
- Tur: o'chirish / qayta yuklash / uxlatish / yoqish. Vaqt: hozir yoki `datetime-local` (brauzer mintaqasida, ISO'ga aylantiriladi).
- "Davom etish" → `POST power-actions/preview` → tasdiq oynasi: `deviceCount`, `unbound`, agent online/offline (`null` bo'lsa "MeshCentral javob bermadi"). Ko'p qurilmada admin sonni qo'lda yozadi (raqam aynan `deviceCount` bo'lsagina tugma faollashadi), keyin `POST power-actions` `confirmDeviceCount` bilan. 409 `confirmation_required` → preview qayta olinadi.
- Amallar ro'yxati va tafsiloti: running amal tafsiloti 2 s da yangilanadi. Har qurilma holati va sababi tarjimada. `unknown` alohida izoh bilan ("natija tasdiqlanmadi"). Scheduled/running amalni bekor qilish.
- Jadvallar: kunlar (Du–Ya), `HH:MM`, vaqt mintaqasi (default `Intl.DateTimeFormat().resolvedOptions().timeZone`), yoqish/o'chirish, o'chirish. Yaratishda tasdiq yuqoridagidek.

- [ ] **Step 1: Failing testlar** (soxta `Api`):
  - `confirm is enabled only when the typed count matches the preview`;
  - `a confirmation_required reply refreshes the preview`;
  - `organization scope is offered only to an org admin`;
  - `a running action refreshes until completed and shows per-device reasons`;
  - `creating a schedule sends days, time and the browser timezone`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS. **Step 5:** Commit `feat(web): power actions and schedules for IT admins`.

### Task 8: Brauzer e2e (headless) va CI

**Files:**
- Create: `apps/web/e2e/{harness.ts,web.e2e.ts}`
- Modify: `vitest.config.ts` (`web-e2e` loyihasi: `apps/web/e2e/**/*.e2e.ts`, `fileParallelism: false`, `testTimeout: 90_000`), root `package.json` (`"test:e2e:web": "pnpm --filter @netschool/web build && vitest run --project web-e2e"`), `.github/workflows/ci.yml` (`web-e2e` ishi: `pnpm exec playwright install --with-deps chromium`, keyin `pnpm test:e2e:web`)

**Harness:**
- `startTestApp({ workers: true, webDistDir: 'apps/web/dist', deviceManagement: mesh.factory, mesh: { connected: true } })`.
- Seed: org admin, teacher (xonaga biriktirilgan), 2 qurilma (P1e test `deviceRequest` yordamchilari bilan heartbeat va miniatura yuboradi).
- `chromium.launch({ headless: true, args: ['--ignore-certificate-errors-spki-list=<test cert SPKI sha256 base64>'] })`.

- [ ] **Step 1: E2e testlar:**
  - `a teacher signs in, starts a lesson and sees live thumbnails`;
  - `a message reaches both devices and the per-device result shows succeeded` (qurilmalar receipt yuboradi);
  - `locking then unlocking shows the overlay state per device`;
  - `an org admin shuts down a room after confirming the device count and sees each result` (FakeMesh: node offline → `succeeded`);
  - `a teacher has no power page` (`/power` → ruxsat yo'q sahifasi).
- [ ] **Step 2:** `pnpm test:e2e:web` → PASS. Ishga tushgandan keyin brauzer jarayoni qolmaganini tekshirish (`pgrep -f chrome-headless-shell` bo'sh). **Step 3:** Commit `test(web): headless browser flows against the hub`. **Step 4:** Push qilinganda CI `web-e2e` yashil.

### Task 9: Hujjatlar

**Files:**
- Create: `docs/adr/0011-web-panel.md`, `apps/web/README.md`
- Modify: `docs/superpowers/plans/2026-10-27-netschool-roadmap.md` (P1f holati; `apps/desktop` alohida qatorga), `docs/adr/0009-companion.md` (WS fan-out bajarildi), `docs/adr/0003-session-gateway.md` (frame-ancestors)

- [ ] **Step 1:**
  - ADR 0011: same-origin hosting va CSP; stream formati va backpressure; iframe va renew worker; events/devices so'rovlari; i18n; `apps/desktop` chiqarilgani; cheklovlar (presence event'lari yo'q — 10 s so'rov; bitta API jarayoni uchun in-process notifier).
  - README: dev (Vite proxy, Origin), build, `WEB_DIST_DIR`.
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm test` → PASS. Commit `docs: record web panel decisions`.
