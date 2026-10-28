# ADR 0006: Darslar, buyruqlar, outbox va events

Sana: 2026-10-28 · Holat: qabul qilingan · Kontekst: P1c · Reja: [p1c-lessons-commands](../superpowers/plans/2026-10-28-p1c-lessons-commands.md)

## Maqsad

Teacher xonada dars ochib-yopadi, darsdagi qurilmalarga typed buyruq yuboradi va har qurilma natijasini ko'radi; qurilma buyruqni tez oladi; overlay server yo'qolsa o'zi tushadi; panel `snapshot + cursor` bilan sinxron (spec §8–§11, §15.1).

## Qarorlar

- **Dars.** `POST /rooms/{roomId}/lessons` — xonaga biriktirilgan teacher (yoki admin). Bitta xonada bitta `active` dars va bitta qurilmada bitta faol dars biriktirmasi — partial unique indekslar (parallel so'rovda ham). Boshlanishda xonadagi (retired bo'lmagan) qurilmalar `lesson_devices`ga yoziladi; dars davomida qo'shilgan qurilma keyingi darsga kiradi. Davomiylik 5…480 daqiqa (default 90); vaqt tugasa maintenance worker `timeout` bilan yopadi. Yopish: egasi (`teacher`) yoki site/org admin (`admin`, recovery). Yopilganda qurilmalar bo'shaydi va ochiq target'lar `cancelled`.
- **Ruxsat.** Teacher o'z xonasida darsni ochadi, o'qiydi, buyruqlarni ko'radi; yopish va buyruq berish faqat **o'z darsida** (`ownerUserId`). it_support o'qiydi. Begona/noma'lum ID — bir xil audit qilingan 403.
- **Buyruqlar.** Turlar: `message.show`, `overlay.lock`, `overlay.unlock` (zod discriminated union; boshqa tur, shell yo'q). Target'lar faqat shu darsdagi qurilmalar. Har target capability bo'yicha: `available` → `pending`, `requires_permission` → `failed/permission_required`, aks holda `failed/unsupported`. Hech biri qodir emas → 409 `capability_unavailable`; qodirlarning hammasi offline → 503 `device_offline` (hech narsa yozilmaydi); aks holda 202 — offline target TTL ichida kutadi. Natija target bo'yicha va `summary` har holat soni bilan; umumiy "success" yo'q.
- **Lifecycle.** `pending → sent → acknowledged → succeeded | failed | expired | cancelled` (`packages/domain` `applyReceipt`). Terminal holatdan chiqish yo'q; bir xil receipt qayta kelsa no-op, ziddi 409. Holat o'zgarishi shartli `UPDATE … WHERE status = current` — receipt, expiry va dars tugashi poygasida eskirgan holat yozilmaydi. Pull target qatorlarini `FOR UPDATE` bilan oladi: parallel tugagan dars yoki expiry'dan keyin bekor qilingan buyruq yetkazilmaydi. Har receipt `command_receipts`da.
- **Qurilma kanali.** P1b imzolangan so'rovlari ustida: `GET /device/commands?wait=0..25` (long-poll) va `POST /device/commands/{id}/receipt`. `sent` target ack kelguncha har pull'da qayta beriladi (at-least-once); qurilma `commandId`/`sequence` bo'yicha takrorni tashlaydi. `sequence` = global monoton `commands.seq`: eski `lock` yangisidan keyin qo'llanmaydi. Muddati o'tgan yoki tugagan darsdagi buyruq yetkazilmaydi.
- **Overlay lease (holat + buyruq).** Buyruq tez yetkazish va per-device ack uchun; xavfsizlik esa holatda: `lesson_devices.overlay_locked/overlay_seq` va heartbeat javobi `lesson: { id, overlay: { locked, sequence, leaseExpiresAt: now + 120 s } } | null`. Qurilma overlay'ni faqat lease ichida ushlaydi — server o'chsa yoki dars tugasa 120 s ichida tushadi; reboot'dan keyin server `null` qaytaradi, eskirgan lock qaytmaydi (§10, §15.1). Lease nisbiy `leaseSeconds` bilan ham beriladi: qurilma uni monoton taymer bilan hisoblaydi (noto'g'ri OS soati lease'ni uzaytirmaydi). Istalgan holat faqat yangiroq `sequence` bilan yoziladi (parallel lock/unlock eski holatga qaytmaydi). `overlay.unlock` xavfsiz yo'nalish: capability/offline darvozasidan qat'i nazar barcha nishonlangan a'zolar uchun yoziladi (offline sinfni ham ochish mumkin). Istalgan holat dars holati: lock buyrug'ining yetkazilishi `expired` bo'lsa ham, dars davomida qayta ulangan qurilma teacher belgilagan holatni oladi.
- **`Idempotency-Key`.** Dars ochish/yopish va buyruq berishda majburiy (`^[A-Za-z0-9_-]{8,128}$`). Kalit qatori ish bilan bitta tranzaksiyada: bir xil so'rov → saqlangan status va body (yangi yozuv yo'q), boshqa body → 409, xato bilan tugagan so'rov saqlanmaydi; parallel bir xil kalit — biri bajaradi, qolganlari commit'dan keyin saqlangan javobni oladi. Faqat o'z PK buzilishi replay deb olinadi. Doira: actor + marshrut, 24 soat.
- **Events.** Har mutatsiya bilan bitta tranzaksiyada `events` (global `seq`). `GET /events?roomId=&after=&wait=`: `after` yo'q yoki tozalangan voqealardan eski → `resync: true` + snapshot (faol dars va so'nggi 50 buyruq); aks holda xonaning keyingi voqealari. `seq` insert paytida, commit esa boshqa tartibda bo'ladi; shuning uchun har event yozuvi xona bo'yicha advisory lock'ni (`pg_advisory_xact_lock`) commit'gacha ushlaydi — bir xonada seq tartibi commit tartibiga teng, cursor voqeani o'tkazib yubormaydi (real PostgreSQL testi). Bir nechta xonaga yozadigan tranzaksiya lock'larni tartiblangan holda oldindan oladi. Cursor snapshot'dan oldin olinadi (takror bo'lishi mumkin, yo'qolmaydi). Long-poll, WS/SSE emas: brauzer va qurilma uchun bir xil oddiy HTTP, proxy/gateway bilan muammosiz; o'lchov kerak bo'lsa keyin WS.
- **Outbox.** Tashqi effektlar (hozir: long-poll'larni uyg'otish; P1d'da MeshCentral revoke) mutatsiya bilan bitta tranzaksiyada `outbox`ga. Worker har 250 ms `FOR UPDATE SKIP LOCKED` bilan oladi; xato → eksponensial kutish (1 s…60 s), 10 urinishdan keyin to'xtaydi (qator diagnostika uchun qoladi). 250 ms yetkazish kechikishi ack p95 ≤1 s maqsadi ichida.
- **Maintenance.** Har 1 s: muddati o'tgan target'lar `expired` (ochiq target'lar partial indeksi orqali), vaqti tugagan darslar yopiladi; tozalash daqiqada bir marta (idempotency kalitlari 24 soat, bajarilgan outbox 1 kun, events 7 kun; har biri indekslangan). Parked outbox qatorlari due indeksiga kirmaydi.
- **Qurilma ko'chirilsa yoki retire qilinsa** u eski xona darsidan chiqadi (a'zolik tugaydi, ochiq target'lar `cancelled`) — boshqa xona teacher'i unga buyruq bera olmaydi (§15.1).
- **Takroriy so'rov oldindan.** Buyruq berishda saqlangan javob a'zolik tekshiruvidan oldin olinadi: dars tugagach kelgan tarmoq qayta urinishi ham 202 va o'sha javobni oladi.
- **Audit.** `lesson.start`, `lesson.end` (sabab, bekor qilingan target soni; timeout'da actor null), `command.issue` (tur va target soni; xabar matni yo'q). Receipt'lar audit emas.
- **Yangi error kodi:** `device_offline` 503.

## P1c'da yo'q (ongli ravishda)

- Control lease va `409 control_busy`, remote session'ni darsga ulash — P1d.
- Power/reboot buyruqlari (MeshCentral orqali) va `unknown` natija — keyingi bosqich.
- Help request, chat, guruhlar, dars davomida qurilma qo'shish/olib tashlash.
- Companion klienti (overlay'ni ko'rsatish, lease'ni hisoblash) — P1e; teacher paneli — P1f.

## Ma'lum cheklovlar

- Notifier va workerlar bitta API jarayoni ichida; bir nechta replika uchun umumiy uyg'otish (masalan PostgreSQL `LISTEN/NOTIFY`) kerak bo'ladi.
- Outbox handler'lari claim tranzaksiyasi ichida ishlaydi — hozir faqat xotiradagi uyg'otish; P1d'dagi tashqi chaqiriqlar tranzaksiyadan tashqariga chiqariladi.
- "Parallel" testlar PGlite'da ketma-ket bajariladi; real parallellik `apps/api/test/concurrency.pg.test.ts`da (faqat `TEST_DATABASE_URL` bilan — CI `unit` job'i).

## Dalillar

`apps/api/test/`: `lessons.test.ts`, `commands.test.ts`, `device-commands.test.ts`, `idempotency.test.ts`, `outbox.test.ts`, `maintenance.test.ts`, `events.test.ts`, `db-invariants.test.ts`; `packages/domain/test/{authorize,commands}.test.ts`; `packages/contracts/test/commands.test.ts`.
