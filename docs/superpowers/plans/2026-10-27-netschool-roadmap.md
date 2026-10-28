# NetSchool — to'liq amalga oshirish yo'l xaritasi

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md)

Bu hujjat butun loyihani **mustaqil sub-planlarga** bo'ladi. Har sub-plan o'zi ishlaydigan, testlangan natija beradi va o'z navbatida alohida batafsil plan fayli sifatida yoziladi (`2026-..-<id>-<nom>.md`). Batafsil plan faqat oldingi sub-plan tugagach yoziladi: masalan, P0b rejasi P0a'da real MeshCentral protokoli bilan ishlagan adapterdan olingan faktlarga tayanadi.

Hozir batafsil yozilgan: **P0a** → [2026-10-27-p0a-foundation-meshcentral-adapter.md](2026-10-27-p0a-foundation-meshcentral-adapter.md).

## Umumiy cheklovlar (barcha sub-planlar uchun)

- MeshCentral: `infra/meshcentral/upstream` submodule, pin `adce1ec488dc884ce947ea4e4808e6a520609b17` (1.3.1); `upstream/` tahrirlanmaydi, patch → alohida `meshcentral-fork` (§5.3).
- MeshCentral protokolini faqat `packages/meshcentral-adapter` biladi; MeshCentral DB jadvallari o'qilmaydi/yozilmaydi (§5.1).
- `packages/domain` MeshCentral, Electron, Nest yoki SQL klientni import qilmaydi (§12).
- TLS tekshiruvi o'chirilmaydi (`rejectUnauthorized: false` taqiqlangan) (§5.1).
- Teacher API'da arbitrary shell/script yo'q (§9).
- Har business recordda `organization_id`, kerakli joyda `site_id` (§8).
- Media kadrlari DB/outbox/auditga yozilmaydi (§11).
- Private key'lar repoda bo'lmaydi; `meshcentral-data/` ignor qilingan.

## Bosqichlar va sub-planlar

### 0-bosqich — integratsiya va OS PoC

| ID | Sub-plan | Natija (deliverable) | Bog'liq |
|---|---|---|---|
| **P0a** | Monorepo poydevori + MeshCentral adapter | pnpm/TS/vitest monorepo; `domain` port; `contracts` capability schema; adapter: TLS-tekshiruvli persistent WS klient, correlation/timeout/reconnect, inventory, events, scoped principal grant/revoke; real MeshCentral'ga qarshi contract testlar | — |
| **P0b** | Remote session broker + gateway PoC | Bir martalik ticket → HttpOnly gateway cookie; MeshCentral HTTP/WS reverse proxy (faqat ruxsatli yo'llar); sessiyaga qisqa umrli principal (1 node, view/control rights); revoke faol WS'ni uzadi. §5.2 "Majburiy PoC" bandlari test sifatida. **Qaror nuqtasi:** gateway qamray olmaydigan endpoint topilsa → fork patch/plugin ADR. **Holat: bajarildi** ([reja](2026-10-27-p0b-session-gateway.md), [ADR 0003](../../adr/0003-session-gateway.md)); qaror nuqtasi: fork patch shart emas | P0a |
| **P0c** | OS PoC va release lock | Windows, macOS, Linux X11, Linux Wayland'da enrollment → inventory → view → control → revoke runbook va natijalari; to'ldirilgan capability matrix (`docs/poc/capability-matrix.md`); risklar ro'yxati; `upstream.lock.json` da image digest + agent manifest; offline agent cache | P0b |

Qabul: P0c'da har OS natijasi qayd etilgan; hech qaysi OS sinovsiz "qo'llanadi" deb belgilanmagan.

### 1-bosqich — sinf uchun MVP

| ID | Sub-plan | Natija | Bog'liq |
|---|---|---|---|
| **P1a** | School hub skeleti | `apps/api` NestJS modular monolith; PostgreSQL + Drizzle migratsiyalar; `infra/compose/` (gateway, api, meshcentral, postgres — MeshCentral uchun alohida DB/user §4); Identity & Access (SchoolAdmin/Teacher/ITSupport/Student), Organization (organizations/sites/rooms), audit_events; offline login. **Holat: bajarildi** ([reja](2026-10-28-p1a-school-hub-skeleton.md), [ADR 0004](../../adr/0004-school-hub-api.md)); gateway servisi compose'ga P1d'da qo'shiladi | P0a |
| **P1b** | Devices va enrollment | `POST /api/v1/enrollments`, `/claim` (bir martalik token + qurilmada yaratilgan public key); `mesh_bindings` unique `(mesh_instance_id, mesh_domain_id, mesh_node_id)`; admin tasdiqlaydigan Companion↔MeshAgent bog'lash; device_capabilities; heartbeat freshness (10 s, 30 s'da stale). **Holat: bajarildi** ([reja](2026-10-28-p1b-devices-enrollment.md), [ADR 0005](../../adr/0005-devices-enrollment.md)); P0c'dan oldin bajarildi — capability faqat qurilma hisoboti, hech bir OS sertifikatlanmagan; compose'da MeshCentral ulanishi P1d'da | P1a, P0c |
| **P1c** | Lessons, commands, outbox, events | Dars lifecycle, xonada bitta active lesson (partial unique); commands/command_targets/receipts; `pending→sent→acknowledged→succeeded|failed|expired|cancelled`; outbox worker; `Idempotency-Key`; `GET /api/v1/events` (snapshot + cursor); barqaror error kodlari (`403 scope_denied`, `409 control_busy`, `409 capability_unavailable`, `503 device_offline`) | P1b |
| **P1d** | Remote sessions (mahsulot) | P0b broker'ni API'ga ulash: `POST /lessons/{id}/remote-sessions`, `DELETE /remote-sessions/{id}`; control lease 30 s / 10 s renewal, monoton fencing; end-lesson revoke; startup reconciliation | P1c, P0b |
| **P1e** | Companion (student, Electron) | Enrollment klienti (fail-closed TLS), WS kanal, heartbeat, binary JPEG miniaturalar (320–480 px, 1–2 fps), soft overlay (120 s lease, monotonic timer, rebootda eskirgan policy qaytmaydi), help/message, SQLite cache; renderer sandbox + contextIsolation | P1c |
| **P1f** | Teacher web panel | `apps/web` React+Vite: sinf setkasi (30 tile, latest-frame), dars boshqaruvi, buyruqlar va har device natijasi, remote viewer iframe (`packages/remote-viewer`), uz/ru/en; `apps/desktop` Electron qobig'i | P1d, P1e |
| **P1g** | MVP qabul e2e | `tests/e2e`: §15.1 qabul mezonlari (quyida) | P1f |

P1 qabul (§15.1): boshqa xona/maktab qurilmasiga kirish rad; view-only'da klaviatura ishlamaydi; bitta device'da ikki teacher control lease ololmaydi; end-lesson faol controlni belgilangan muddatda uzadi; server o'chsa overlay cheksiz qolmaydi; agent reboot/reconnectdan keyin eskirgan lock qaytmaydi.

### 2-bosqich — o'qitish jarayoni va policy

| ID | Sub-plan | Natija |
|---|---|---|
| P2a | Media SFU | Self-hosted LiveKit; Teacher Show / student presentation; room token publish/subscribe rollari; alohida revoke; UDP cheklanganda fallback |
| P2b | Assignments | StoragePort (pilotda lokal volume), xavfsiz nom/yo'l, kvota, checksum, retry |
| P2c | Policy | School baseline + lesson policy qatlamlari; immutable versiyalar, desired/applied/ack; managed browser extension |
| P2d | OS helper (Go) | Windows service / macOS daemon / Linux systemd; ACL'li pipe/socket, versiyalangan allowlist, umumiy shell yo'q |
| P2e | Installer va update | Signed installer (Windows), notarization (macOS), Linux paketlar; mos server/agent/Companion manifest; rollback; uninstall fayllarni buzmaydi |
| P2f | Load va real sinf | 30 endpoint bir dars, 60 stress; §11 maqsadlari: miniatura p95 ≤2 s, command ack p95 ≤1 s, LAN input p95 ≤250 ms, reconcile ≤30 s |

### 3-bosqich — mobil, ChromeOS, ko'p maktab

P3a Android/iOS/iPadOS native participant PoC → capability; P3b ChromeOS managed extension; P3c multi-school (har maktabga o'z hub'i) + cloud eventual sync (har site bitta authoritative writer).

## Bajarish tartibi

P0a → P0b → P0c → P1a (P0a'dan keyin P0b/P0c bilan parallel boshlash mumkin) → P1b → P1c → P1d ∥ P1e → P1f → P1g → 2-bosqich.

Har sub-plan tugashida: testlar yashil, `docs/adr/` da yangi qarorlar, keyingi sub-planning batafsil rejasi yoziladi.
