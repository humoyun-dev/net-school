# ADR 0011: O'qituvchi va IT admin veb-paneli

Sana: 2026-11-02 · Holat: qabul qilingan · Kontekst: P1f · Reja: [p1f-web-panel](../superpowers/plans/2026-11-02-p1f-web-panel.md)

## Maqsad

Brauzerdagi `apps/web` paneli (spec §3, §4, §11, §13, §15.1). Panel ikki xil foydalanuvchi uchun:
- **O'qituvchi** xonasini tanlaydi va dars boshlaydi. Sinf setkasida har kompyuterning jonli miniaturasi, holati va yordam so'rovi ko'rinadi. Hammaga yoki tanlanganlarga xabar, bloklash va ochish yuboradi va har kompyuter natijasini ko'radi. Kompyuterni panel ichida ko'radi yoki boshqaradi, darsni tugatadi.
- **IT admin** P1h quvvat amallarini qurilmalar sonini tasdiqlab yuboradi, natijalarni kuzatadi va haftalik jadvallarni boshqaradi.

Tillar: uz, ru, en.

## Egasining qarorlari (2026-11-02)

- P1f'ga IT admin quvvat sahifasi kiradi.
- Admin boshqaruv sahifalari keyinroq alohida reja bo'ladi: foydalanuvchilar va rollar, binolar va xonalar, enrollment, MeshCentral'ga bog'lash, audit.

## Qarorlar

### Server tomoni

- **Panel API origin'idan beriladi.** API `WEB_DIST_DIR` berilsa, `/api/` dan boshqa GET va HEAD so'rovlarga SPA'ni beradi.
  - Sabab: sessiya cookie'si `__Host-` va `SameSite=Strict`, Origin tekshiruvi `PUBLIC_ORIGIN`ga aynan teng bo'lishi kerak, CORS yo'q.
  - `index.html` `no-store`, `assets/*` bir yil va `immutable` bilan beriladi.
  - Har javobda CSP: `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `img-src 'self' blob: data:`, `connect-src 'self'`, `frame-src <GATEWAY_PUBLIC_ORIGIN>`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`. Qo'shimcha headerlar: `nosniff`, `no-referrer`.
  - `/api/...` yo'llari JSON 404 bo'lib qoladi. `assets` tashqarisiga traversal yo'q.
- **Umumiy upgrade router** (`UpgradeRouter`). API HTTP server'ida bitta `upgrade` tinglovchisi bor va WS so'rovini yo'l bo'yicha yo'naltiradi; mos yo'l bo'lmasa 404. Avval har noma'lum yo'l 400 bilan yopilardi (ADR 0009 keyingi ishlari).
- **O'qituvchi uchun miniatura oqimi** (ADR 0009'da P1f'ga qoldirilgan WS fan-out). Manzil: `wss://<PUBLIC_ORIGIN>/api/v1/lessons/{id}/thumbnails/stream`.
  - **Kirish:** cookie sessiya, `Origin === PUBLIC_ORIGIN` (CSWSH himoyasi) va `remote.view` huquqi kerak. Rad etish auditga yoziladi.
  - **Xabar formati:** binary, 16 bayt qurilma UUID + JPEG.
  - **Tezlik:**
    - Har qurilmadan ko'pi bilan 1 kadr `THUMBNAIL_INTERVAL_MS` (1000) ichida yuboriladi.
    - Interval ichida kelgan kadr tashlanmaydi: interval tugaganda o'sha paytdagi eng oxirgi kadr yuboriladi. Aks holda ~1 s jitter fps'ni yarmiga tushirardi.
    - `bufferedAmount > 1 MiB` bo'lsa kadr tashlanadi: sekin o'qituvchi buferni to'ldirmaydi.
  - **Qayta tekshiruv:** har 30 s da sessiya, huquq va dars tekshiriladi. Close kodlari: `4401` sessiya tugagan, `4410` dars tugagan.
- **Viewer iframe ichida** (ADR 0003 framing sharti). Gateway upstream `x-frame-options`ni olib tashlaydi va `content-security-policy: frame-ancestors <PUBLIC_ORIGIN>` beradi. Upstream CSP'ning boshqa direktivalari saqlanadi. Gateway boshqa portda, lekin same-site, shuning uchun `SameSite=Strict` cookie iframe'da yuboriladi. Haqiqiy MeshCentral bilan contract testida tekshirilgan; `frameAncestor`siz test yiqiladi.
- **API xato kodlari** `@netschool/contracts`ga ko'chdi (`API_ERROR_CODES`). Server va panel tarjimalari shu bitta ro'yxatdan foydalanadi.

### Panel (`apps/web`)

- **Stek:** React 19.3, react-router 8.5, Vite 8.3, aniq pin qilingan. UI kutubxonasi yo'q, oddiy CSS.
- **API klienti.**
  - So'rovlar `credentials: 'same-origin'` va JSON bilan.
  - Xato `ApiFailure` (`status`, `code`, `correlationId`) bo'ladi va foydalanuvchiga kod bo'yicha tarjima qilinadi.
  - 401 kelsa login sahifasiga qaytish manzili bilan o'tadi. `next` faqat panel ichidagi yo'l bo'lishi mumkin (ochiq redirect yo'q).
  - `password_change_required` kelsa parol sahifasiga o'tadi.
- **Bir niyat — bitta `Idempotency-Key`** (`createIntent`/`useIntent`). Tarmoq xatosi yoki 5xx'dan keyingi qayta urinish o'sha kalit bilan; muvaffaqiyat yoki aniq 4xx javobdan keyin kalit yangilanadi. Shu sababli ikki marta bosish bitta dars yoki amal yaratadi.
- **Sinf holati.**
  - Voqealar long-poll bilan olinadi (`wait=25`); xato bo'lsa 1–30 s backoff.
  - Holat sof reducer'da (`lesson-state.ts`): `resync` kelsa snapshot holatni to'liq almashtiradi, `seq ≤ lastSeq` voqealar qayta qo'llanmaydi.
  - Voqeada faqat id kelsa, buyruq `GET /commands/{id}` bilan, dars `lessons/active` bilan to'ldiriladi.
  - Kompyuterlar ro'yxati har 10 s da so'raladi (presence voqealari yo'q).
- **Miniaturalar.** Har kompyuterning faqat oxirgi `blob:` URL'i tirik, eskisi darhol bo'shatiladi. 90 daqiqalik darsda xotira o'smaydi.
- **Remote viewer** (`packages/remote-viewer`, React'siz).
  - Ketma-ketlik: sessiya → ticket → iframe.
  - Sandbox: `allow-scripts allow-same-origin allow-forms allow-pointer-lock`.
  - Lease har 10 s da yangilanadi (control rejimida fencing bilan). Yangilash Vite module Worker taymerida ishlaydi, chunki fon tabida asosiy oqim taymerlari sekinlashadi. Worker same-origin asset bo'lgani uchun CSP'ga mos.
  - Tarmoq xatosida keyingi tick qayta uriniladi (lease 30 s). 409/404 kelsa sessiya `expired` bo'ladi.
  - Panel yopilganda yoki sahifadan chiqilganda keepalive `DELETE` yuboriladi.
- **Quvvat sahifasi.**
  - Ko'lam: butun universitet (faqat org admin), binolar, xonalar yoki kompyuterlar.
  - Preview'dan keyin tasdiq oynasi chiqadi. Bir nechta kompyuterda admin sonni qo'lda yozadi va son aynan teng bo'lsagina tugma yoqiladi.
  - 409 `confirmation_required` kelsa preview o'sha oynada yangilanadi va yozilgan son tozalanadi.
  - Ishlayotgan amal 2 s da yangilanadi. `unknown` natija alohida izoh bilan ko'rsatiladi.
  - Jadval: kunlar, `HH:MM` va brauzerning vaqt mintaqasi.
- **i18n:** uz (default), ru, en, `localStorage['netschool.locale']`. Kalitlar tip bilan tekshiriladi; test hamma tilda hamma kalit va hamma API xato kodi borligini tekshiradi.

### Sinovlar

- Unit testlar `pnpm test` ichida (vitest `apps/*/test/**/*.test.{ts,tsx}`, jsdom faylma-fayl).
- **E2E** (`pnpm test:e2e:web`, CI'da `web-e2e` ishi):
  - Panel build qilinadi, real API (`startTestApp`, worker'lar yoqiq) ishga tushadi va headless Chromium ochiladi. Ekranga hech narsa chiqmaydi.
  - TLS tekshiruvi o'chirilmaydi: test sertifikatining SPKI'si pin qilinadi.
  - Kompyuterlar o'rnida imzolangan HTTP so'rovlar (buyruq olish va receipt) ishlatiladi.

## Cheklovlar va keyingi ishlar

- **`apps/desktop`** (Electron qobig'i) bu bosqichga kirmadi. Panel brauzerda to'liq ishlaydi; qobiq alohida kichik reja bo'ladi.
- **Admin boshqaruv sahifalari** yo'q: foydalanuvchilar, rollar, xonalar, enrollment tokenlari, MeshCentral bog'lash, audit jurnali. API'lari tayyor.
- **Presence voqealari yo'q:** kompyuter holati 10 s kechikish bilan yangilanadi.
- **Long-poll notifier** in-process ishlaydi, ya'ni bitta API jarayoni uchun (ADR 0006).
- **Xona nomi** ro'yxatdan router holati orqali keladi: to'g'ridan-to'g'ri havola bilan ochilganda umumiy "Xona" sarlavhasi ko'rinadi (`GET /rooms/{id}` yo'q).
- **Bir vaqtda bitta viewer:** bir brauzerda faqat bitta viewer paneli ochiladi (gateway cookie'si bitta, ADR 0003 `superseded`).
- **Miniatura e2e** kadrni `ThumbnailStore`ga to'g'ridan-to'g'ri qo'yadi. Qurilma ingest WS'i API testlarida va Companion e2e'da qamralgan.

## Dalillar

- **Server:**
  - `apps/api/test/static-web.test.ts`, `config.test.ts`;
  - `thumbnail-stream.test.ts`, `thumbnails.test.ts` (router 404);
  - `packages/session-gateway/test/headers.test.ts`;
  - `tests/contracts/viewer-browser.test.ts` (`the viewer loads inside an iframe on the panel origin`).
- **Panel:**
  - `apps/web/test/{client,intent,i18n,login,lesson-state,thumbnail-feed,room-page,remote-panel,power-page}.test.*`;
  - `packages/remote-viewer/test/session-controller.test.ts`.
- **E2E:** `apps/web/e2e/web.e2e.ts`.
