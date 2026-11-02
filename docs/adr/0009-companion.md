# ADR 0009: Companion (o'quvchi, Electron)

Sana: 2026-11-02 · Holat: qabul qilingan · Kontekst: P1e · Reja: [p1e-companion](../superpowers/plans/2026-11-02-p1e-companion.md)

## Maqsad

Maktab kompyuterida o'quvchi Companion'i: IT admin uni bir marta ro'yxatdan o'tkazadi (fail-closed TLS); Companion imzolangan kanal orqali heartbeat yuboradi, buyruqlarni oladi (xabar, yumshoq overlay), o'quvchiga "yordam" (qo'l ko'tarish) beradi va dars davomida ekran miniaturasini hub'ga yuboradi; hub oxirgi kadrni faqat xotirada saqlaydi va faqat dars egasiga beradi (spec §3, §4, §6, §7, §10, §11, §15.1).

## Egasining qarorlari (2026-11-02)

- **P1d avval tugatiladi.** PR #7 tuzatishlardan keyin `main`ga rebase-merge qilindi; P1e `p1e-companion` branch'ida `main`dan boshlandi.
- **Qurilma kaliti mashina bo'yicha.** IT admin har kompyuterda bir marta `enroll` ishga tushiradi; kalit mashina katalogiga yoziladi va kompyuterdagi har OS user sessiyasidagi Companion o'shani ishlatadi (umumiy kompyuter — hub'da bitta qurilma). P2d'da kalit OS Helper'ga o'tadi.
- **Help — faqat qo'l ko'tarish, matnsiz.** Chat 2-bosqichda.
- **Bajarish:** Task 0–4 subagent-driven (har vazifa alohida implementer va reviewer), Task 5–12 egasining so'rovi bilan inline (tezlik uchun), oxirida butun branch review.
- **Sinovlar ishchi ekranga ta'sir qilmaydi:** e2e oynalarni ekranda ko'rsatmaydigan yashirin rejimda ishlaydi (quyida).

## Qarorlar

### Hub tomoni

- **Heartbeat yo'riqnomasi.** Faol darsdagi qurilmaga `lesson.thumbnails = { intervalMs: 1000, maxWidth: 480 }` va `lesson.helpRequest = { id, raisedAt } | null`. Miniatura konstantalari `packages/domain` `thumbnails.ts`da: interval 1000 ms, Companion eng tez 500 ms, hub 400 ms dan tez kelgan kadrni tashlaydi, kadr ≤ 262 144 bayt, kenglik ≤ 480 px, hub'da TTL 10 s.
- **Help requests.** `help_requests` (migratsiya `0009`): bir `(lesson, device)` uchun eng ko'pi bitta ochiq so'rov; `clear_reason` ∈ `teacher | device | lesson_ended | device_left`. `POST`/`DELETE /api/v1/device/help-request` (imzolangan), `DELETE /api/v1/help-requests/{id}` (`help.clear` = `command.issue` rollari; begona/noma'lum — audited 403). Voqealar `help_request.raised/cleared`, snapshot'da `helpRequests`. Audit yo'q.
- **Lock tartibi.** Yopiladigan hamma qatorlar xona advisory lock'idan oldin qulflanadi (ADR 0008): `clearOpen` faqat help qatorlarini `FOR UPDATE` bilan yangilaydi, `announceCleared` xona lock'ini olib voqealarni yozadi; `endLesson`/`#leaveLesson`: `clearOpen` → `closeRemoteSessions` → `announceCleared` → o'z voqeasi. Dastlabki variant (voqeani `clearOpen` o'zi yozgan) sessiya yopilishi bilan deadlock bergan — real PostgreSQL testida tasdiqlangan.
- **Miniatura WS.** `GET /api/v1/device/thumbnails` — imzolangan upgrade (`DeviceVerifier`: guard bilan bitta qoida, ADR 0005), qurilma faol dars a'zosi bo'lishi shart (aks holda 409). Soket o'sha darsga bog'lanadi; 5 s da a'zolik qayta tekshiriladi (`4409 left_lesson`), bitta qurilmaga bitta soket (`4000 replaced`), JPEG SOI tekshiruvi, rad etilgan upgrade soketi to'liq yopiladi (`destroy`). Kadr DB/outbox/audit/logga yozilmaydi.
- **Oxirgi kadr.** `GET /api/v1/lessons/{lessonId}/devices/{deviceId}/thumbnail` — `remote.view` (dars egasi yoki admin), qurilma darsning faol a'zosi; `image/jpeg`, `cache-control: no-store`, `x-ns-frame-seq`, `x-ns-frame-at`; kadr yo'q yoki boshqa darsniki → 404. Teacher setkasi uchun WS fan-out — P1f.

### Companion (`apps/companion`)

- **Tuzilma.** `src/core/` — Electron'siz modullar (imzo, hub klienti, enrollment, SQLite kesh, overlay, buyruqlar, miniatura, agent), real hub'ga qarshi sinaladi; `src/main/` — Electron (oynalar, tray, capture, IPC); `src/preload/` — allowlist ko'prik; `src/renderer/` — sandbox'dagi oddiy TS sahifalar. Asosiy jarayon CommonJS bundle (`dist/main.cjs`): Playwright ESM entry'li Electron'ni ulay olmaydi. Hamma kod (zod, ws, workspace paketlari) bundle ichida — `enroll` va ilova node_modules'siz ishlaydi.
- **Mashina katalogi.** Windows `%ProgramData%\NetSchool\companion`, macOS `/Library/Application Support/NetSchool/companion`, Linux `/var/lib/netschool/companion` (`NETSCHOOL_COMPANION_DIR`); `device.json`, `device.key` (PKCS#8), ixtiyoriy `hub-ca.pem`; har fayl atomik yoziladi, `device.json` oxirida. Per-user holat `<userData>/state.sqlite` (`node:sqlite`).
- **Enrollment.** `enroll --hub <origin> [--ca <pem>] [--token …|NETSCHOOL_ENROLL_TOKEN] [--force]`: kalit qurilmada yaratiladi, claim muvaffaqiyatli bo'lgandan keyingina diskka yoziladi; token hech qachon chiqarilmaydi; chiqish kodlari 0/2 (foydalanish)/3 (hub, TLS)/4 (rad etildi yoki allaqachon ro'yxatdan o'tgan).
- **TLS fail-closed.** Faqat `https:` origin; `hub-ca.pem` bo'lsa faqat unga, aks holda tizim root'lariga ishoniladi; hostname har doim tekshiriladi; `rejectUnauthorized` kodda umuman yo'q (testda tekshiriladi).
- **Imzo va soat.** Timestamp jarayon ichida qat'iy o'sadi. 401 bo'lsa hub javobidagi `Date` bilan qurilma soati 5 s dan ko'p farq qilsa offset shunga o'rnatiladi (aks holda 0) va bir marta qayta imzolanadi — maktab kompyuterlarida soat ko'pincha noto'g'ri.
- **Kanal.** Buyruqlar long-poll'da (ADR 0006), WS faqat miniaturalar uchun. Hub klientida `control` (ketma-ket) va `poll` (alohida) yo'laklari.
- **Overlay lease.** 120 s; monoton taymer (`performance.now`) **yoki** OS uptime — qaysi biri avval tugasa (macOS'da `performance.now` uyquni sanamaydi). Faqat teng yoki yangiroq `sequence` qo'llanadi. Lock keshda saqlanadi va faqat bitta boot ichida, qolgan lease muddatigacha tiklanadi; reboot'dan keyin eskirgan lock qaytmaydi. Overlay matni «Yumshoq bloklash».
- **Buyruqlar.** `sequence` bo'yicha son tartibida; ack → bajarish → natija keshga → yakuniy receipt; qayta yetkazilgan buyruq qayta bajarilmaydi (faqat natija qayta yuboriladi). Hub ack'ni rad etsa (4xx) buyruq bajarilmaydi. Noma'lum tur — `failed/unsupported`, noto'g'ri payload — `failed/error`. Eskirgan overlay buyrug'i — `succeeded` (qurilma yangiroq holatda).
- **Agent.** Hub holatining yagona egasi heartbeat sikli (`online` paytida eskirgan lock ko'rinmaydi); TLS xatosi `tls_error` (urinish davom etadi); ketma-ket ikki 401 → `rejected` (long-poll to'xtaydi, 60 s da tekshiruv). Capability har 30 s qayta hisoblanadi, faqat o'zgarganda yuboriladi.
- **Capability.** `classroom.message`, `classroom.overlay` (soft), `classroom.help`, `classroom.thumbnails` (macOS ruxsati yo'q — `requires_permission`; Wayland — `unsupported`). `remote.desktop` hisobotda yo'q (MeshAgent manba).
- **Miniatura yuklovchi.** Faqat yo'riqnoma bor va capability `available` bo'lsa; soket band bo'lsa kadr olinmaydi (navbat yo'q); null va katta kadr yuborilmaydi; uzilsa 1 s → 30 s backoff; `4409`/`4000` → keyingi yo'riqnomagacha kutadi (bir mashinadagi ikki nusxa bir-birini haydamaydi).
- **Electron xavfsizligi.** Har oynada `sandbox`, `contextIsolation`, Node yo'q, `webviewTag: false`, `devTools: false`; sessiyada faqat `file:` so'rovlari, barcha permission rad; navigatsiya va yangi oyna taqiqlangan; CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'`. IPC faqat renderer katalogidagi sahifalardan (`isTrustedSender`), argumentlar zod bilan. O'qituvchi matni faqat `textContent` bilan ko'rsatiladi. Tray'da "Chiqish" yo'q.
- **Chiqish.** OS o'chirilganda yoki chiqishda overlay va xabar oynalari yo'q qilinadi (macOS `closable: false` oynani yopmaydi va o'chirishni to'sardi), agent to'xtagach kesh yopiladi.
- **Lokal.** uz (default), ru, en — tizim tilidan; `NETSCHOOL_COMPANION_LOCALE` bilan qotirish mumkin.
- **Sinov rejimi.** `NETSCHOOL_COMPANION_TEST_HIDDEN=1` (faqat `NETSCHOOL_COMPANION_STATE_DIR` bilan birga) — oynalar yaratiladi va tekshiriladi, lekin ekranda ko'rsatilmaydi.

## Ma'lum cheklovlar

- Kalitni P2d'gacha qurilmadagi har OS user o'qiy oladi: faqat shu qurilma nomidan imzolash mumkin (masalan soxta miniatura), boshqa qurilma yoki foydalanuvchi huquqi yo'q.
- Bitta nusxa faqat bitta OS user ichida kafolatlanadi; bir vaqtda bir nechta sessiya — P2d (Helper faol konsol sessiyasini biladi).
- Soft overlay'ni ilova jarayonini o'ldirish bilan chetlab o'tish mumkin; avtoishga tushirish va qayta ishga tushirish — P2e/P2d. Bir boot ichida qayta ishga tushsa lock keshdan tiklanadi.
- Wayland miniaturalari — P0c. macOS'da ekran yozish ruxsati foydalanuvchi tomonidan beriladi.
- Teacher help'ni yopsa qurilma buni keyingi heartbeat'da (≤ 10 s) ko'radi.
- Miniatura ombori bitta API jarayonining xotirasida (ADR 0006 cheklovi).
- Installer, imzolash, avtoyangilash — P2e.
- Yakuniy review'ga qoldirilgan kichik nuqtalar ledger'da (`.superpowers/sdd/`), shu jumladan P1c/P1d'dan qolgan `#leaveLesson` buyruq target'larini xona lock'idan keyin bekor qilishi.

## Dalillar

- Hub: `apps/api/test/help-requests.test.ts`, `thumbnails.test.ts`, `db-invariants.test.ts`, `device-presence.test.ts`, `concurrency.pg.test.ts` (`raising help while the lesson ends leaves no open request`, `ending a lesson with open help never deadlocks with remote session close`); `packages/domain/test/authorize.test.ts`; `packages/contracts/test/help-requests.test.ts`.
- Companion (Node, real hub'ga qarshi): `apps/companion/test/{identity,machine-store,hub-client,capabilities,enroll,cache,overlay,thumbnails,commands,agent,security,ipc,i18n}.test.ts`.
- Haqiqiy Electron: `apps/companion/e2e/companion.e2e.ts` (sandbox va Node yo'qligi, lock/unlock, xabar oddiy matn sifatida, help, qayta ishga tushganda lock keshdan) — CI `companion-e2e` (xvfb, Chromium sandbox yoqilgan).
