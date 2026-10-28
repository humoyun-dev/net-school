# ADR 0004: School hub API skeleti

Sana: 2026-10-28 · Holat: qabul qilingan · Kontekst: P1a · Reja: [p1a-school-hub-skeleton](../superpowers/plans/2026-10-28-p1a-school-hub-skeleton.md)

## Maqsad

Maktab hub'ida internet va tashqi IdP'siz ishlaydigan API: oflayn login, rollar va scope'li ruxsatlar, tashkilot/filial/xona, har o'zgarish va rad etish uchun audit. MeshCentral alohida jarayon va alohida database'da (spec §2, §4, §8, §13).

## Qarorlar

- **NestJS 11 (Express), metadata'siz DI.** Har konstruktor parametri aniq `@Inject(TOKEN)` bilan; `emitDecoratorMetadata` ishlatilmaydi. Sabab: vitest (Vite 8/oxc), `tsx` va esbuild decorator metadata chiqarmaydi; aniq token bilan uchala muhitda bir xil ishlaydi. Validatsiya faqat zod (`packages/contracts/src/api/v1/*`), class-validator yo'q. Biome uchun `unsafeParameterDecoratorsEnabled` yoqilgan.
- **Build.** `apps/api/scripts/build.mjs` (esbuild) `dist/main.mjs` va `dist/cli.mjs` ni yig'adi: `@netschool/*` bundle ichida, npm dependency'lar tashqarida. Migratsiyalar `apps/api/drizzle/` (drizzle-kit generate, qo'lda tahrirlanmaydi, Biome'dan chiqarilgan).
- **Ma'lumotlar.** PostgreSQL 17 + Drizzle. Tenant xavfsizligi DB darajasida: `rooms`, `role_assignments`, `room_memberships` composite FK `(organization_id, …)` orqali faqat o'z tashkilotining site/user/room'iga bog'lana oladi. Username hub bo'yicha `lower(username)` unique. Rol check constraint bilan; school_admin'dan boshqa rol site talab qiladi. RLS — shared deployment kelganda.
- **Test strategiyasi.** Lokal: in-process PGlite (Docker kerak emas). CI: `TEST_DATABASE_URL` bilan real `postgres:17`, har test fayli uchun yangi database. Ikkalasida bir xil migratsiyalar.
- **Ruxsatlar.** `packages/domain` `authorize(actor, action, target)` — sof funksiya, default rad. Org-wide school_admin tashkilotda hammasini; site school_admin o'z site'ida xona/user/audit va faqat o'z site'idagi school_admin bo'lmagan rollarni beradi/oladi; it_support o'qiydi; teacher faqat biriktirilgan xonalarni ko'radi; student hech narsa. `RoleAssignment` `organizationId`ni ham saqlaydi (begona rol/assignment hech narsa bermaydi).
- **Mavjudlikni oshkor qilmaslik.** Begona tashkilotning, noma'lum yoki noto'g'ri formatdagi ID — hammasi bir xil `403 scope_denied`, rad etish audit qilinadi (`src/common/access.ts`).
- **Login va sessiya.** scrypt (N=32768, r=8, p=1, 64 bayt, 16 bayt salt; faqat shu parametrlar qabul qilinadi). Cookie `__Host-ns_sid` (HttpOnly, Secure, SameSite=Strict, `Max-Age`siz), DB'da token SHA-256; idle 2 soat, absolyut 12 soat. Noma'lum user va noto'g'ri parol bir xil 401 va bir xil scrypt ishi. Hisob: 10 ketma-ket xato → 15 daqiqa qulf, atomik `UPDATE` bilan (parallel urinishlarda ham aniq bir marta, `auth.lockout` audit); IP bo'yicha 30 urinish/daqiqa → 429. Parol almashtirish boshqa sessiyalarni, rol olib tashlash/disable/CLI reset esa barcha sessiyalarni bekor qiladi. `must_change_password` bo'lsa faqat `/me`, `/auth/password`, `/auth/logout`.
- **CSRF.** `GET`/`HEAD`dan boshqa har so'rovda `Origin === PUBLIC_ORIGIN`.
- **Audit.** `audit_events` mutatsiya bilan bitta tranzaksiyada; rad etishlar va login urinishlari ham. `details` 4 KiB bilan cheklangan, `password|token|cookie|secret` kalitlari olib tashlanadi. O'qish site bo'yicha scope'li, `(at, id)` cursor bilan.
- **Oflayn tiklash.** `netschool-admin` CLI: `migrate`, `bootstrap` (faqat bo'sh hub'da; bir martalik parol faqat stdout'ga), `reset-password` (qulfni yechadi, sessiyalarni bekor qiladi, audit `auth.password_reset`).
- **Deploy.** `infra/compose/`: `postgres` (`netschool` va `meshcentral` alohida database va owner user, `REVOKE CONNECT … FROM PUBLIC`), `meshcentral` (submodule'dan build, `pg@8.16.3` oldindan o'rnatilgan — oflayn ishga tushadi; non-root, port 4430), `api-migrate`, `api`. Faqat `api` publish qilinadi (`443→8443`). Sirlar Docker secrets fayllari (`secrets/`, gitignored, fayl 644 / papka 700 — konteyner ichidagi non-root userlar o'qishi uchun).

## P1a'da yo'q (ongli ravishda)

- `Idempotency-Key` — P1c (buyruqlar va outbox).
- RLS, SSO, cloud sync — keyingi bosqichlar.
- Student login oqimi — P1e (Companion).
- Gateway servisi compose'da — P1d (`trustedProxy` shu bilan birga yangilanadi).
- MeshCentral agent porti — P0c natijasiga ko'ra.
- Backup/restore (spec §13: NetSchool DB, MeshCentral DB va data, kalitlar) — alohida vazifa; MeshCentral `autoBackup` o'chiq.

## Ma'lum cheklovlar

- Login IP limiti xotirada (bitta API jarayoni uchun); bir nechta replika bo'lsa umumiy store kerak.
- Lokal mashinada Docker bo'lmasa compose faqat CI'dagi `compose-smoke` job'ida tekshiriladi; real PostgreSQL yo'li ham faqat CI'da.

## Dalillar

`apps/api/test/`: `auth.test.ts` (cookie, lockout, parallel lockout, sessiya chegaralari), `organization.test.ts` (cross-organization rad etish va audit), `users.test.ts` (huquqni oshirish, sessiya bekor qilish), `audit-read.test.ts`, `cli.test.ts`, `db-invariants.test.ts`; `packages/domain/test/authorize.test.ts` (rol × action × scope jadvali); `infra/compose/test/compose.test.ts`; CI `compose-smoke`.
