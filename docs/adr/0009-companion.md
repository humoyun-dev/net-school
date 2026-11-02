# ADR 0009: Companion (o'quvchi, Electron)

Sana: 2026-11-02 · Holat: **jarayonda** (P1e bajarilmoqda; yakunda Task 12 to'ldiradi va "qabul qilingan" qiladi) · Kontekst: P1e · Reja: [p1e-companion](../superpowers/plans/2026-11-02-p1e-companion.md)

## Maqsad

Maktab kompyuterida o'quvchi Companion'i: IT admin uni bir marta ro'yxatdan o'tkazadi (fail-closed TLS); Companion imzolangan kanal orqali heartbeat yuboradi, buyruqlarni oladi (xabar, yumshoq overlay), o'quvchiga "yordam" (qo'l ko'tarish) beradi va dars davomida ekran miniaturasini hub'ga yuboradi; hub oxirgi kadrni faqat xotirada saqlaydi va faqat dars egasiga beradi (spec §3, §4, §6, §7, §10, §11, §15.1).

## Egasining qarorlari (2026-11-02)

- **P1d avval tugatiladi.** PR #7 (P1d) tuzatishlardan keyin `main`ga rebase-merge qilindi; P1e `p1e-companion` branch'ida `main`dan boshlandi. Sabab: P1e P1d o'zgartirgan contracts, events va migratsiyalarga tayanadi.
- **Qurilma kaliti mashina bo'yicha.** IT admin har kompyuterda bir marta `enroll` ishga tushiradi; Ed25519 kalit mashina katalogiga yoziladi va kompyuterdagi har OS user sessiyasidagi Companion o'shani ishlatadi. Sabab: umumiy kompyuterga turli o'quvchilar kiradi, hub'da esa qurilma bitta yozuv (spec §8: talaba va qurilma bir obyekt emas). P2d'da kalit OS Helper'ga o'tadi.
- **Help — faqat qo'l ko'tarish, matnsiz.** Chat 2-bosqichda. Sabab: matn moderatsiya va audit qoidalarini talab qiladi.

## Qarorlar (bajarilgan)

- **Heartbeat yo'riqnomasi.** Faol darsdagi qurilmaga heartbeat javobida `lesson.thumbnails = { intervalMs: 1000, maxWidth: 480 }` va `lesson.helpRequest = { id, raisedAt } | null` (ikkalasi majburiy maydon). Miniatura konstantalari `packages/domain` `thumbnails.ts`da: interval 1000 ms, Companion eng tez 500 ms, hub 400 ms dan tez kelgan kadrni tashlaydi, kadr ≤ 262 144 bayt, kenglik ≤ 480 px, hub'da TTL 10 s.
- **Help requests.** `help_requests` jadvali (migratsiya `0009`): bir `(lesson_id, device_id)` uchun eng ko'pi bitta ochiq so'rov (partial unique), `clear_reason` ∈ `teacher | device | lesson_ended | device_left`, `cleared_at` va `clear_reason` birga. Marshrutlar:
  - `POST /api/v1/device/help-request` (imzolangan, body `{}`) — ochiq so'rov bo'lsa o'shani qaytaradi; faol dars a'zosi bo'lmasa 409 `conflict`.
  - `DELETE /api/v1/device/help-request` (imzolangan) — qurilma o'z so'rovini qaytarib oladi (`device`); so'rov yo'q bo'lsa no-op.
  - `DELETE /api/v1/help-requests/{id}` — dars egasi teacher yoki site/org admin (`help.clear`, rollar `command.issue` bilan bir xil); begona/noma'lum ID — audited 403; `Idempotency-Key` talab qilinmaydi (`DELETE /remote-sessions/{id}` kabi).
  - Dars tugashi (teacher, admin, maintenance `timeout`) ochiq so'rovlarni `lesson_ended`, qurilmaning darsdan chiqishi `device_left` bilan yopadi.
  - Voqealar `help_request.raised`, `help_request.cleared` (`data`: `helpRequestId`, `deviceId`, yopilishda `reason`) va `notify.rooms`; events snapshot'ida `helpRequests` (darsning ochiq so'rovlari). Help audit qilinmaydi (receipt'lar kabi).
- **Lock tartibi (help yopilishi).** Hamma yopiladigan qatorlarning lock'lari xona advisory lock'idan **oldin** olinadi (ADR 0008 qoidasi). Shuning uchun yopish ikki bosqichli: `clearOpen` faqat help qatorlarini `FOR UPDATE` (id tartibida) bilan qulflab yangilaydi va yopilganlarni qaytaradi — xona lock'i ham, event ham yo'q; `announceCleared` xona lock'ini olib `help_request.cleared` voqealarini yozadi. `endLesson` va `#leaveLesson`: `clearOpen` → `closeRemoteSessions` → `announceCleared` → o'z xona voqeasi. Sabab: dastlabki variantda `clearOpen` voqeani o'zi yozib xona lock'ini erta olardi, keyin `closeRemoteSessions` sessiya qatorlarini qulflardi — sessiya aktivatsiyasi va yopilishi (sessiya → xona) bilan deadlock (real PostgreSQL testida 500 bilan tasdiqlangan). `raise`: dars `FOR SHARE` → a'zolik qatori `FOR SHARE` → help qatori → xona lock'i; parallel dars tugashi ochiq so'rov qoldirmaydi.

## Qarorlar (rejada, bajarilgach shu yerda tasdiqlanadi)

- **Mashina katalogi:** Windows `%ProgramData%\NetSchool\companion`, macOS `/Library/Application Support/NetSchool/companion`, Linux `/var/lib/netschool/companion` (`NETSCHOOL_COMPANION_DIR` bilan override); `device.json`, `device.key` (PKCS#8), ixtiyoriy `hub-ca.pem`. Per-user holat `<userData>/state.sqlite` (`node:sqlite` — Electron 45.2.1 ichida ishlashi tekshirilgan).
- **TLS fail-closed:** faqat `https:`; `hub-ca.pem` bo'lsa faqat unga ishoniladi; hostname har doim tekshiriladi; xato → ulanish yo'q, xavfsiz bo'lmagan fallback yo'q.
- **Qurilma soati:** imzo timestamp'i 401 javobidagi `Date` sarlavhasidan olingan offset bilan tuzatiladi (maktab kompyuterlarida soat ko'pincha noto'g'ri). Overlay lease soatdan mustaqil.
- **Kanal:** buyruqlar long-poll'da qoladi (ADR 0006); WS faqat binary miniaturalar uchun (`/api/v1/device/thumbnails`, imzolangan upgrade, oxirgi kadr xotirada, kadr qaysi dars uchun olingan bo'lsa faqat o'sha darsda beriladi).
- **Overlay:** 120 s lease monoton taymer bilan (`performance.now`, restart'lar orasida `os.uptime`); saqlangan lock faqat bitta boot ichida tiklanadi; interfeysda «Yumshoq bloklash».
- **Capability:** `classroom.message`, `classroom.overlay` (soft), `classroom.help`, `classroom.thumbnails` (`requires_permission` — macOS ekran ruxsati yo'q; `unsupported` — Wayland). `remote.desktop` Companion hisobotida yo'q (manba MeshAgent).
- **Electron:** renderer `sandbox`, `contextIsolation`, Node yo'q, faqat ilovaning o'z sahifalari, permission so'rovlari rad.

## Bajarish qoidalari (P1e)

- Vazifalar subagent-driven tartibda: har vazifa alohida implementer va reviewer, oxirida butun branch review. Holat va qarorlar ledger'i git'ga kirmaydi (`.superpowers/sdd/`), yakunda shu ADR'ga ko'chiriladi.
- Real PostgreSQL testlari (`concurrency.pg.test.ts`) lokalda vaqtinchalik `postgres:17` konteynerida ishga tushiriladi; CI ularni `TEST_DATABASE_URL` bilan har doim ishlatadi.
- Electron'siz sinaladigan modullar (`src/core/`, `security.ts`, `ipc.ts`, `i18n.ts`) `electron`dan faqat `import type` qiladi.

## Ma'lum cheklovlar (hozircha)

- Kalitni P2d'gacha qurilmadagi har OS user o'qiy oladi: u faqat shu qurilma nomidan imzolay oladi (masalan soxta miniatura yuborish), boshqa qurilma yoki foydalanuvchi huquqini bermaydi.
- Teacher help'ni yopsa qurilma buni keyingi heartbeat'da (≤ 10 s) ko'radi; qurilmani darhol uyg'otish yo'q.
- Kichik poyga: ochiq so'rovga takroriy `raise` va shu paytda teacher `clear`/`withdraw` commit bo'lsa `raise` 500 qaytarishi mumkin (yakuniy review'da ko'riladi).
- P1c/P1d'dan qolgan: `#leaveLesson` buyruq target'larini xona lock'idan keyin bekor qiladi, receipt yo'li esa target → xona tartibida — yakuniy review'da ko'riladi.

## Dalillar (hozircha)

`apps/api/test/help-requests.test.ts`, `db-invariants.test.ts` (help cheklovlari), `concurrency.pg.test.ts` (`raising help while the lesson ends leaves no open request`, `ending a lesson with open help never deadlocks with remote session close`), `device-presence.test.ts` (`heartbeat tells a lesson device to send thumbnails`); `packages/domain/test/authorize.test.ts` (`help.clear follows command.issue`); `packages/contracts/test/help-requests.test.ts`.
