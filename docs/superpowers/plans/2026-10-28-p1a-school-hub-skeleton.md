# P1a — School hub skeleti Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maktab hub'ida ishlaydigan `apps/api` (NestJS modular monolith) — PostgreSQL + Drizzle migratsiyalari, oflayn lokal login, rollar (SchoolAdmin/Teacher/ITSupport/Student) va scope'li ruxsatlar, tashkilot/filial/xona boshqaruvi, har mutatsiya va rad etilgan urinish uchun audit; hamda `infra/compose/` (postgres, meshcentral alohida DB bilan, api).

**Architecture:** Ruxsat qoidalari `packages/domain`da sof funksiya (`authorize`), HTTP/DB'dan mustaqil. `apps/api` Nest modullari (`identity`, `organization`, `audit`, `health`) use case'larni Drizzle tranzaksiyasi ichida bajaradi; mutatsiya va uning audit yozuvi bitta tranzaksiyada. DTO'lar `packages/contracts`da zod sxemalar. Testlar in-process PGlite'da (lokal, Docker'siz) va CI'da real PostgreSQL'da (`TEST_DATABASE_URL`) bir xil migratsiyalar bilan.

**Tech Stack:** Node 24, NestJS 11 (`@nestjs/platform-express`), Drizzle ORM + drizzle-kit, `pg`, `@electric-sql/pglite` (faqat test), zod 4, esbuild (api bundle), PostgreSQL 17, Docker Compose.

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md) §2, §4, §8, §9 (error kodlari), §12, §13. Yo'l xaritasi: [2026-10-27-netschool-roadmap.md](2026-10-27-netschool-roadmap.md) (P1a qatori va "Umumiy cheklovlar").

## Global Constraints

- Yo'l xaritasidagi "Umumiy cheklovlar" to'liq amal qiladi (MeshCentral pin va `upstream/` tahrirlanmaydi; `packages/domain` Nest/SQL/MeshCentral import qilmaydi; TLS tekshiruvi o'chirilmaydi; har business recordda `organization_id`; private key'lar repoda yo'q).
- NestJS 11, Express platformasi. `emitDecoratorMetadata` ishlatilmaydi: har konstruktor parametri aniq `@Inject(TOKEN)` bilan; validatsiya faqat zod (class-validator/class-transformer yo'q). `experimentalDecorators: true` faqat `apps/api/tsconfig.json`da.
- API faqat HTTPS'da tinglaydi (oddiy HTTP listener yo'q); sertifikat `TLS_CERT_FILE`/`TLS_KEY_FILE`dan.
- Yo'l prefiksi `/api/v1`. Xato konverti: `{ "error": { "code": string, "message": string, "correlationId": string } }`. Kodlar va statuslar: `validation_failed` 400, `unauthenticated` 401, `scope_denied` 403, `password_change_required` 403, `not_found` 404, `conflict` 409, `rate_limited` 429, `internal` 500. Xabar matni ichki tafsilot/stack bermaydi.
- Correlation ID: kiruvchi `x-correlation-id` `^[A-Za-z0-9-]{8,64}$`ga mos bo'lsa qabul, aks holda `randomUUID()`; javob headerida va xato konvertida qaytariladi; auditga yoziladi.
- Sessiya: cookie `__Host-ns_sid`, qiymat 32 tasodifiy bayt base64url, DB'da faqat SHA-256; `HttpOnly; Secure; SameSite=Strict; Path=/`, `Max-Age` yo'q. Idle muddat 2 soat, absolyut 12 soat (server tomonda).
- CSRF: `GET`/`HEAD`dan boshqa har so'rov `Origin === PUBLIC_ORIGIN` bo'lishi shart, aks holda 403 `scope_denied`.
- Parol: `crypto.scrypt`, N=32768, r=8, p=1, maxmem 64 MiB, kalit 64 bayt, salt 16 bayt; saqlash formati `scrypt$32768$8$1$<salt b64url>$<hash b64url>`; taqqoslash `timingSafeEqual`. Minimal uzunlik 12, maksimal 256. Parol hech qachon log/audit/xatoga tushmaydi.
- Login cheklovi: bir hisobga ketma-ket 10 xato → 15 daqiqa qulf (atomik DB yangilash); IP bo'yicha in-memory 30 urinish/daqiqa → 429. Noma'lum foydalanuvchi va noto'g'ri parol bir xil javob (401 `unauthenticated`) va o'xshash vaqt (soxta hash bilan scrypt bajariladi).
- Username butun hub bo'yicha unique (`lower(username)` unique index), `^[a-z0-9][a-z0-9._-]{2,63}$`.
- Audit: har muvaffaqiyatli mutatsiya, har rad etilgan ruxsat, har login urinishi `audit_events`ga, mutatsiya bilan **bitta tranzaksiyada**. `details` jsonb 4 KiB'dan oshmaydi; parol/token/cookie yozilmaydi.
- MeshCentral alohida database va DB user'da (`meshcentral`); NetSchool migratsiyalari faqat `netschool` database'ga tegadi. Sirlar `*_FILE` env (Docker secrets) orqali, compose fayl va repoda sir yo'q.
- Kod identifikatorlari ingliz tilida; docs o'zbekcha.

## Review Focus

1. **Boshqa tashkilot ID'sini almashtirish** — A tashkilot admini B tashkilot xonasini o'zgartirishga urinsa 403 `scope_denied`, hech narsa yozilmaydi, rad etish audit qilinadi. → Task 7 testi `cross-organization room update is denied and audited`.
2. **Huquqni oshirish** — faqat bitta site'ga SchoolAdmin bo'lgan foydalanuvchi org-wide SchoolAdmin yarata olmaydi yoki boshqa site'da rol bera olmaydi. → Task 8 testi `site admin cannot escalate to organization scope or other sites`.
3. **Parallel noto'g'ri parollar** — 20 ta parallel noto'g'ri login ham hisobni aniq 10-xatodan keyin qulflaydi (race'da limit oshib ketmaydi, to'g'ri parol ham qulf davomida rad). → Task 5 testi `concurrent failed logins lock the account exactly once`.
4. **Parol tiklash yoki rol olib tashlangandan keyingi sessiya** — eski sessiyalar darhol yaroqsiz. → Task 6 testi `reset-password revokes existing sessions`, Task 8 testi `removing a role revokes the user's sessions`.
5. **Sessiya muddati chegaralari** — idle 2 soat va absolyut 12 soat aniq chegarada (soxta soat) to'g'ri tugaydi; faol foydalanuvchining idle muddati uzayadi, absolyut emas. → Task 5 testi `session expires at idle and absolute limits`.

---

### Task 0: Branch

- [ ] **Step 1:** PR #1 va #2 merge bo'lgan bo'lsa `git switch main && git pull && git switch -c p1a-school-hub`; aks holda stacked: `git switch p0b-session-gateway && git switch -c p1a-school-hub`.

### Task 1: `apps/api` skeleti — config, HTTPS, health, correlation ID, xato konverti

**Files:**
- Create: `apps/api/{package.json,tsconfig.json}`, `apps/api/src/{main.ts,app.module.ts}`, `apps/api/src/config/config.ts`, `apps/api/src/common/{correlation.ts,errors.ts,error-filter.ts,origin-guard.ts}`, `apps/api/src/modules/health/health.controller.ts`, `apps/api/scripts/build.mjs`, `apps/api/test/support/app.ts`
- Modify: `vitest.config.ts` (unit project `include`ga `apps/*/test/**/*.test.ts`), `pnpm-workspace.yaml` (kerak bo'lsa)
- Test: `apps/api/test/health.test.ts`, `apps/api/test/errors.test.ts`

**Interfaces:**
- Produces:

```typescript
// config.ts — process.env'dan zod bilan; *_FILE bo'lsa fayldan o'qiladi
export interface ApiConfig { port: number; host: string; publicOrigin: string; tls: { cert: string; key: string }; databaseUrl: string }
export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig; // xato → aniq xabar bilan throw (qiymat sirini chiqarmasdan)
// errors.ts
export type ApiErrorCode = 'validation_failed'|'unauthenticated'|'scope_denied'|'password_change_required'|'not_found'|'conflict'|'rate_limited'|'internal';
export class ApiError extends Error { constructor(code: ApiErrorCode, message?: string) }
// test/support/app.ts
// Task 3 bu imzoga `db?: TestDb` opsiyasini qo'shadi (berilmasa yangi test DB yaratiladi)
export async function startTestApp(opts?: { now?: () => number }): Promise<{ origin: string; ca: string; request(method: string, path: string, init?: { body?: unknown; cookie?: string; headers?: Record<string,string> }): Promise<{ status: number; headers: Headers; json: any }>; close(): Promise<void> }>;
```
- `GET /api/v1/healthz` → 200 `{ "status": "ok" }` (Task 3'dan keyin `"db": "ok" | "down"`).
- Env nomlari: `API_PORT` (default 8443), `API_HOST` (default `0.0.0.0`), `PUBLIC_ORIGIN`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `DATABASE_URL` yoki `DATABASE_URL_FILE`.
- Build: `scripts/build.mjs` esbuild bilan `src/main.ts` → `dist/main.mjs` (`platform:'node'`, `target:'node24'`, `format:'esm'`, `bundle:true`, `@netschool/*` bundle ichiga, `package.json` dependencies tashqarida). Root script `pnpm --filter @netschool/api build`.

- [ ] **Step 1: Failing testlar:** `health.test.ts`: `healthz responds over HTTPS with ok`, `response echoes a valid correlation id and replaces an invalid one`; `errors.test.ts`: `unknown route returns not_found envelope`, `thrown ApiError maps to status and envelope`, `unexpected error returns internal without details`, `POST with foreign Origin is rejected with scope_denied` (test-only controller orqali), `loadConfig rejects missing PUBLIC_ORIGIN and reads *_FILE`.
- [ ] **Step 2:** `pnpm test -- apps/api` → FAIL.
- [ ] **Step 3:** Implement. TLS sertifikati testda `@netschool/test-support` `makeCert`. Nest `bodyParser` limiti 64 KiB.
- [ ] **Step 4:** `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm --filter @netschool/api build` → 0; `node apps/api/dist/main.mjs` test sertifikati bilan ishga tushib `healthz` 200 beradi (qo'lda tekshiruv, natija hisobotda).
- [ ] **Step 5:** Commit `feat(api): NestJS skeleton with HTTPS, config, health and error envelope`.

### Task 2: Ruxsat qoidalari (`packages/domain`)

**Files:**
- Create: `packages/domain/src/access/{roles.ts,authorize.ts}`, `packages/domain/test/authorize.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces:

```typescript
export type Role = 'school_admin' | 'teacher' | 'it_support' | 'student';
export interface RoleAssignment { role: Role; organizationId: string; siteId: string | null } // null = organization-wide (faqat school_admin uchun ruxsat)
export interface Actor { userId: string; organizationId: string; assignments: readonly RoleAssignment[]; roomIds: readonly string[] } // roomIds = teacher biriktirilgan xonalar
export type Action =
  | 'organization.read' | 'site.create' | 'site.read' | 'room.create' | 'room.update' | 'room.read'
  | 'room.assign_teacher' | 'user.create' | 'user.read' | 'role.assign' | 'role.remove' | 'audit.read';
export interface Target { organizationId: string; siteId?: string | null; roomId?: string; role?: RoleAssignment } // role.assign/role.remove uchun berilayotgan rol
export type Decision = { allowed: true } | { allowed: false; reason: 'scope_denied' };
export function authorize(actor: Actor, action: Action, target: Target): Decision;
```

Qoidalar (aniq):
- `actor.organizationId !== target.organizationId` → rad (har qanday action).
- org-wide `school_admin` (siteId null): tashkilotdagi hamma action ruxsat.
- site `school_admin`: `target.siteId === o'sha site` bo'lsa `site.read`, `room.*`, `room.assign_teacher`, `user.read`, `user.create`, `audit.read`, `role.assign`/`role.remove` — **faqat** `target.role.siteId === o'sha site` va `target.role.role !== 'school_admin'` bo'lsa. `site.create` va org-wide rol berish rad.
- `it_support` (site): o'sha site uchun `site.read`, `room.read`, `user.read`.
- `teacher` (site): o'sha site uchun `site.read`; `room.read` faqat `actor.roomIds` ichidagi xona.
- `student`: `organization.read` dan boshqasi rad.
- `organization.read`: tashkilotda kamida bitta assignment bo'lsa ruxsat.
- Boshqa hamma holat rad.

- [ ] **Step 1: Failing test** `authorize.test.ts` — jadval testi (`test.each`): har rol × har action × {o'z site, boshqa site, boshqa tashkilot}; plus `site admin cannot grant school_admin even within own site`, `site admin cannot grant roles in another site`, `teacher reads only assigned rooms`, `actor without assignments is denied everything`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** `pnpm test`, `lint`, `typecheck` → 0.
- [ ] **Step 5:** Commit `feat(domain): role-scoped authorization rules`.

### Task 3: DB sxema, migratsiyalar va test DB

**Files:**
- Create: `apps/api/src/db/{schema.ts,client.ts,migrate.ts}`, `apps/api/drizzle.config.ts`, `apps/api/drizzle/` (drizzle-kit generate natijasi), `apps/api/test/support/db.ts`, `apps/api/test/db-invariants.test.ts`
- Modify: `apps/api/src/modules/health/health.controller.ts` (`db` holati), `apps/api/test/support/app.ts` (`startTestApp`ga `db?: TestDb`), `.github/workflows/ci.yml` (unit job'ga `postgres:17` service va `TEST_DATABASE_URL`)

**Interfaces:**
- Produces:

```typescript
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>; // pg va PGlite ikkalasiga mos
export const DB: unique symbol; // Nest injection token
export async function migrateDb(db: Db, driver: 'pg' | 'pglite'): Promise<void>; // apps/api/drizzle papkasidan
export interface TestDb { db: Db; reset(): Promise<void>; close(): Promise<void> }
export async function createTestDb(): Promise<TestDb>; // TEST_DATABASE_URL bo'lsa real PG'da yangi tasodifiy schema/database, aks holda PGlite
```

Jadvallar (barcha `id uuid default gen_random_uuid()`, vaqtlar `timestamptz`):
- `organizations(id, name, created_at)`
- `sites(id, organization_id → organizations, name, created_at)`, `unique(organization_id, id)`, `unique(organization_id, name)`
- `rooms(id, organization_id, site_id, name, created_at)`, FK `(organization_id, site_id) → sites(organization_id, id)`, `unique(organization_id, id)`, `unique(site_id, name)`
- `users(id, organization_id → organizations, username, display_name, password_hash, must_change_password bool default false, failed_login_count int default 0, locked_until timestamptz null, disabled_at null, created_at)`, unique index `lower(username)`, `unique(organization_id, id)`
- `role_assignments(id, organization_id, user_id, role text check in (4 rol), site_id null, created_at)`, FK `(organization_id, user_id) → users(organization_id, id)`, FK `(organization_id, site_id) → sites(organization_id, id)`, check `role = 'school_admin' or site_id is not null`, unique `(user_id, role, coalesce(site_id, '00000000-0000-0000-0000-000000000000'))`
- `room_memberships(organization_id, room_id, user_id, created_at)`, PK `(room_id, user_id)`, FK'lar `(organization_id, room_id) → rooms`, `(organization_id, user_id) → users`
- `auth_sessions(id, user_id → users on delete cascade, token_hash bytea unique, created_at, last_seen_at, expires_at)` (absolyut muddat `expires_at`)
- `audit_events(id, organization_id null → organizations, site_id null, actor_user_id null, action text, target_type text null, target_id text null, result text check in ('allowed','denied','failed','succeeded'), correlation_id text, details jsonb default '{}', at timestamptz default now())`, check `organization_id is not null or action like 'auth.%'`, index `(organization_id, at desc)`

- [ ] **Step 1: Failing testlar** `db-invariants.test.ts`: `room cannot reference a site of another organization` (FK xatosi), `role assignment cannot reference a site of another organization`, `usernames are unique case-insensitively`, `non-admin role requires a site`, `audit event without organization is allowed only for auth actions`, `migrations apply on an empty database twice idempotently` (`migrateDb` ikki marta).
- [ ] **Step 2:** FAIL → **Step 3:** schema + `drizzle-kit generate` → migratsiya SQL commit qilinadi (qo'lda tahrirlanmaydi; partial/expression index drizzle-kit chiqara olmasa — alohida qo'lda yozilgan migratsiya fayli, izoh bilan). **Step 4:** `pnpm test` (lokal PGlite) → PASS; agar lokal PostgreSQL bo'lsa `TEST_DATABASE_URL=… pnpm test` ham. CI'da real PG bilan.
- [ ] **Step 5:** Commit `feat(api): PostgreSQL schema with tenant-scoped foreign keys and migrations`.

### Task 4: Audit yozuvchi va so'rov konteksti

**Files:**
- Create: `apps/api/src/modules/audit/{audit.module.ts,audit.writer.ts}`, `apps/api/src/common/request-context.ts`
- Test: `apps/api/test/audit-writer.test.ts`

**Interfaces:**
- Consumes: `Db`, `audit_events` (Task 3), correlation ID (Task 1).
- Produces:

```typescript
export interface AuditEntry { organizationId: string | null; siteId?: string | null; actorUserId: string | null; action: string; targetType?: string; targetId?: string; result: 'allowed'|'denied'|'failed'|'succeeded'; details?: Record<string, unknown> }
export class AuditWriter { write(tx: Db, entry: AuditEntry, correlationId: string): Promise<void> } // details JSON > 4096 bayt → { truncated: true }
export interface RequestContext { correlationId: string; clientIp: string; actor: Actor | null; sessionId: string | null }
```

- [ ] **Step 1: Failing testlar:** `audit entry is written inside the caller's transaction and rolled back with it`; `oversized details are replaced with a truncation marker`; `details never contain keys password, token, cookie` (bunday kalitlar bo'lsa olib tashlanadi).
- [ ] **Step 2–4:** FAIL → implement → PASS + lint/typecheck.
- [ ] **Step 5:** Commit `feat(api): transactional audit writer`.

### Task 5: Identity — login, sessiya, logout, me, parol o'zgartirish

**Files:**
- Create: `apps/api/src/modules/identity/{identity.module.ts,password.ts,sessions.ts,login-throttle.ts,auth.controller.ts,auth.guard.ts,actor.loader.ts}`, `packages/contracts/src/api/v1/auth.ts`
- Test: `apps/api/test/password.test.ts`, `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: Task 1–4.
- Produces:

```typescript
export function hashPassword(plain: string): Promise<string>;               // Global Constraints formati
export function verifyPassword(plain: string, stored: string): Promise<boolean>;
export const DUMMY_HASH: string;                                             // noma'lum user uchun vaqtni tenglash
export class SessionService {
  constructor(db: Db, opts: { now: () => number; idleMs: number; absoluteMs: number });
  create(tx: Db, userId: string): Promise<{ token: string; sessionId: string }>;
  resolve(token: string | undefined): Promise<{ sessionId: string; userId: string } | null>; // muddat tekshiradi, last_seen_at yangilaydi (≥60 s farq bo'lsa)
  revoke(sessionId: string): Promise<void>;
  revokeAllForUser(tx: Db, userId: string): Promise<void>;
}
export const AUTH_GUARD: unique symbol; // global guard: @Public() bo'lmagan har route sessiya talab qiladi; mustChangePassword bo'lsa faqat /me, /auth/password, /auth/logout
```
- Endpointlar (`packages/contracts/src/api/v1/auth.ts`da zod sxemalar):
  - `POST /api/v1/auth/login` `{ username, password }` → 200 `{ user: { id, username, displayName, mustChangePassword } }` + `Set-Cookie: __Host-ns_sid=…`. Xato → 401 `unauthenticated` (sabab ko'rsatilmaydi), qulf → 401 (bir xil), IP limiti → 429.
  - `POST /api/v1/auth/logout` → 204, cookie `Max-Age=0` bilan o'chiriladi, sessiya o'chiriladi.
  - `GET /api/v1/me` → `{ user, organizationId, assignments, roomIds }`.
  - `POST /api/v1/auth/password` `{ currentPassword, newPassword }` → 204; boshqa barcha sessiyalar bekor, joriy sessiya qoladi, `must_change_password=false`.
- Audit: `auth.login` (`succeeded`/`failed`, details `{ reason: 'bad_credentials'|'locked'|'disabled' }` — username faqat noma'lum bo'lmagan user uchun `target_id`), `auth.logout`, `auth.password_changed`.

- [ ] **Step 1: Failing testlar:**
  - `password.test.ts`: `hash uses the pinned scrypt format`, `verify accepts the right password and rejects others`, `verify rejects malformed stored hashes without throwing`.
  - `auth.test.ts`: `login sets a host-only HttpOnly Secure SameSite=Strict session cookie`, `wrong password and unknown user get the same 401`, `account locks after 10 failures for 15 minutes` (soxta soat), `concurrent failed logins lock the account exactly once` (Review Focus 3 — 20 parallel), `ip limit returns 429 after 30 attempts per minute`, `session expires at idle and absolute limits` (Review Focus 5), `logout invalidates the session`, `must-change-password restricts routes until the password is changed`, `password change revokes other sessions`, `requests without a session get 401 unauthenticated`, `login failures and successes are audited without the password`.
- [ ] **Step 2–4:** FAIL → implement (xato hisoblagich `UPDATE … SET failed_login_count = failed_login_count + 1 … RETURNING` bilan atomik) → PASS + lint/typecheck.
- [ ] **Step 5:** Commit `feat(api): offline local login with scrypt, lockout and server-side sessions`.

### Task 6: Hub CLI — bootstrap va parolni tiklash

**Files:**
- Create: `apps/api/src/cli/{main.ts,bootstrap.ts,reset-password.ts}`, `apps/api/test/cli.test.ts`
- Modify: `apps/api/package.json` (`"bin": { "netschool-admin": … }`, build skriptiga CLI entry)

**Interfaces:**
- `netschool-admin bootstrap --org <name> --site <name> --admin <username> [--display-name <s>]` → tashkilot, site, org-wide `school_admin` user yaratadi; tasodifiy 20 belgili parolni **faqat stdout'ga bir marta** chiqaradi; `must_change_password=true`. Tashkilot allaqachon mavjud bo'lsa exit 2, hech narsa o'zgarmaydi.
- `netschool-admin reset-password <username>` → yangi tasodifiy parol (stdout), `must_change_password=true`, `failed_login_count=0`, `locked_until=null`, user'ning barcha sessiyalari bekor; audit `auth.password_reset` (actor null, details `{ via: 'cli' }`).
- `netschool-admin migrate` → faqat `migrateDb` (compose'dagi `api-migrate` one-shot servisi shuni ishlatadi); exit 0.
- Hammasi `DATABASE_URL`/`DATABASE_URL_FILE` bilan ishlaydi va avval `migrateDb` chaqiradi. Build skripti CLI'ni `dist/cli.mjs` sifatida ham chiqaradi.

- [ ] **Step 1: Failing testlar:** `migrate applies migrations and is idempotent`, `bootstrap creates org, site and a must-change admin`, `bootstrap refuses to run twice`, `reset-password revokes existing sessions` (Review Focus 4), `reset-password unlocks a locked account`, `cli never writes the password to the audit log`.
- [ ] **Step 2–4:** FAIL → implement (CLI funksiyalari `run(argv, { db, stdout })` ko'rinishida testlanadi) → PASS.
- [ ] **Step 5:** Commit `feat(api): hub CLI for bootstrap and offline password recovery`.

### Task 7: Organization — site'lar, xonalar, teacher biriktirish

**Files:**
- Create: `apps/api/src/modules/organization/{organization.module.ts,sites.controller.ts,rooms.controller.ts,organization.service.ts}`, `packages/contracts/src/api/v1/organization.ts`
- Test: `apps/api/test/organization.test.ts`

**Interfaces:**
- Consumes: `authorize` (Task 2), `AuditWriter` (Task 4), `RequestContext.actor` (Task 5).
- Endpointlar:
  - `GET /api/v1/sites` → actor ko'ra oladigan site'lar (`site.read` bo'yicha filtrlangan).
  - `POST /api/v1/sites` `{ name }` → 201 (`site.create`).
  - `GET /api/v1/sites/{siteId}/rooms` → `room.read` ruxsat etilgan xonalar.
  - `POST /api/v1/sites/{siteId}/rooms` `{ name }` → 201; `PATCH /api/v1/rooms/{roomId}` `{ name }` → 200.
  - `PUT /api/v1/rooms/{roomId}/teachers/{userId}` → 204 (user shu site'da `teacher` roliga ega bo'lishi shart, aks holda 409 `conflict`); `DELETE …` → 204.
- Qoidalar: ID path'dan olingan obyekt avval DB'dan **actor tashkiloti bilan** o'qiladi; topilmasa yoki boshqa tashkilotniki bo'lsa — `authorize` natijasi rad → 403 `scope_denied` (mavjudlikni oshkor qilmaslik uchun ikki holat bir xil). Har rad etish `…denied` audit yozuvi bilan; muvaffaqiyat mutatsiya tranzaksiyasida audit. Nom takrori → 409.

- [ ] **Step 1: Failing testlar:** `org admin creates sites and rooms`, `site admin manages rooms only in own site`, `teacher lists only assigned rooms`, `it support reads rooms but cannot change them`, `cross-organization room update is denied and audited` (Review Focus 1 — hech narsa o'zgarmaydi, audit `denied`), `unknown and foreign room ids look the same (403)`, `assigning a non-teacher to a room is a conflict`, `duplicate room name in a site is a conflict`.
- [ ] **Step 2–4:** FAIL → implement → PASS + lint/typecheck.
- [ ] **Step 5:** Commit `feat(api): organization module with scoped sites, rooms and teacher assignment`.

### Task 8: Foydalanuvchilar, rollar va audit o'qish

**Files:**
- Create: `apps/api/src/modules/identity/{users.controller.ts,users.service.ts}`, `apps/api/src/modules/audit/audit.controller.ts`, `packages/contracts/src/api/v1/{users.ts,audit.ts}`
- Test: `apps/api/test/users.test.ts`, `apps/api/test/audit-read.test.ts`

**Interfaces:**
- Endpointlar:
  - `GET /api/v1/users?siteId=` → `user.read` ko'lamidagi userlar (parol xeshisiz).
  - `POST /api/v1/users` `{ username, displayName, password, roles: [{ role, siteId }] }` → 201; har rol uchun `role.assign` tekshiriladi; `must_change_password=true`.
  - `POST /api/v1/users/{userId}/roles` `{ role, siteId }` → 201; `DELETE /api/v1/users/{userId}/roles/{assignmentId}` → 204 va o'sha userning **barcha sessiyalari bekor**; tashkilotning oxirgi org-wide `school_admin` rolini olib tashlash → 409 `conflict`.
  - `PATCH /api/v1/users/{userId}` `{ disabled: boolean }` → disable'da sessiyalar bekor; o'zini disable qilish → 409.
  - `GET /api/v1/audit-events?siteId=&limit=&before=` → `audit.read`; site admin faqat o'z site'i yozuvlarini; `limit` ≤ 200, default 50; `before` cursor (`at`, `id`).

- [ ] **Step 1: Failing testlar:** `org admin creates a teacher with a site role`, `site admin cannot escalate to organization scope or other sites` (Review Focus 2), `removing a role revokes the user's sessions` (Review Focus 4), `last organization admin cannot be removed`, `disabled user cannot log in and loses sessions`, `user list never includes password hashes`, `audit read is scoped by site and paginates with a stable cursor`, `teacher cannot read audit events`.
- [ ] **Step 2–4:** FAIL → implement → PASS + lint/typecheck.
- [ ] **Step 5:** Commit `feat(api): user and role administration with session revocation; scoped audit read`.

### Task 9: `infra/compose` — postgres, meshcentral (alohida DB), api

**Files:**
- Create: `infra/compose/{compose.yaml,.env.example,README.md}`, `infra/compose/postgres/init/01-databases.sh`, `apps/api/Dockerfile`, `infra/meshcentral/Dockerfile`, `infra/meshcentral/render-config.mjs`, `infra/compose/test/compose.test.ts` (unit project'ga kiritiladi: `infra/*/test/**/*.test.ts`)
- Modify: `vitest.config.ts`, `.github/workflows/ci.yml` (yangi `compose-smoke` job), `.gitignore` (`infra/compose/secrets/`)

**Interfaces / qarorlar:**
- Servislar: `postgres` (`postgres:17`, faqat ichki tarmoq, port publish qilinmaydi), `meshcentral` (submodule'dan build; image ichida `npm ci --omit=optional` + `npm install --no-save pg@8.16.3` — MeshCentral PostgreSQL uchun shu versiyani talab qiladi, `meshcentral.js:4478`; oflayn ishga tushganda internetdan o'rnatmasligi uchun), `api`.
- Sirlar Docker secrets bilan, fayllar `infra/compose/secrets/` (gitignored; `.env.example` va README ularni qanday yaratishni ko'rsatadi): `postgres_superuser_password`, `netschool_db_password`, `meshcentral_db_password`, `api_tls_cert`, `api_tls_key`.
- `01-databases.sh`: `netschool` va `meshcentral` database'lari, har biri o'z owner user'i bilan; `REVOKE CONNECT … FROM PUBLIC`; userlar bir-birining DB'siga ulana olmaydi.
- `render-config.mjs`: `infra/meshcentral/config.template.json` + `settings.postgres { host: 'postgres', port: 5432, user: 'meshcentral', database: 'meshcentral', password: <secret fayldan> }` → `meshcentral-data/config.json`, keyin MeshCentral ishga tushadi. MeshCentral web porti publish **qilinmaydi** (spec §13: admin panel teacher tarmog'iga chiqmaydi); agent porti — P0c'da qaror, hozircha publish yo'q va README'da shunday deyiladi.
- `api`: `apps/api/Dockerfile` multi-stage (pnpm install → `build` → `node:24-slim` + `dist/` + production deps), entrypoint `node dist/main.mjs`, migratsiya `node dist/cli.mjs migrate` alohida one-shot servis (`api-migrate`, `depends_on: postgres healthy`). Faqat `api` 443→8443 publish qilinadi.
- `compose.test.ts` (YAML'ni `yaml` paketi bilan o'qiydi): `only the api publishes a port`, `postgres and meshcentral publish nothing`, `no secret values appear in the compose file` (`environment`da `PASSWORD`/`KEY` bo'lsa faqat `*_FILE` ko'rinishida), `meshcentral and api use different database users`.
- CI `compose-smoke` job (ubuntu, docker): sirlarni tasodifiy yaratadi, `docker compose up -d --build --wait postgres api-migrate api meshcentral`, so'ng: `curl --cacert … https://localhost/api/v1/healthz` → `"db":"ok"`; `docker compose exec postgres psql -U meshcentral -d netschool -c 'select 1'` **muvaffaqiyatsiz** bo'lishi; MeshCentral logida PostgreSQL ulanishi va xatosiz ishga tushish (`docker compose logs meshcentral` → "MeshCentral HTTPS server running"); `docker compose down -v`.

- [ ] **Step 1: Failing test** `compose.test.ts` → **Step 2:** FAIL → **Step 3:** fayllarni yozing → **Step 4:** `pnpm test` PASS; lokal Docker bo'lmasa `compose-smoke` faqat CI'da — hisobotda aniq ayting; Docker bo'lsa lokal ham ishga tushiring.
- [ ] **Step 5:** Commit `feat(infra): school hub compose with separate MeshCentral database`.

### Task 10: Hujjatlar

**Files:**
- Create: `docs/adr/0004-school-hub-api.md`
- Modify: `README.md` (apps/api, infra/compose; ishga tushirish), `docs/superpowers/plans/2026-10-27-netschool-roadmap.md` (P1a holati)

- [ ] **Step 1:** ADR 0004: NestJS Express + explicit `@Inject` (metadata'siz) sababi; zod; Drizzle + PGlite/real PG test strategiyasi; tenant FK'lari; sessiya va parol parametrlari; lockout; CSRF Origin qoidasi; audit tranzaksiyasi; CLI recovery; compose topologiyasi va port siyosati; P1a'da **yo'q** narsalar: `Idempotency-Key` (P1c), RLS (shared deployment), SSO, Student login oqimi (P1e), gateway servisi compose'da (P1d), agent porti (P0c).
- [ ] **Step 2:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:contract` → 0.
- [ ] **Step 3:** Commit `docs: record school hub API decisions`.
