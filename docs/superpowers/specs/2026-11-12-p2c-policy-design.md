# P2c — Policy: bazaviy va dars qatlamlari, versiyalar, desired/applied/ack, managed browser extension

Sana: 2026-11-12. Holat: dizayn, egasi tasdig'ini kutmoqda.
Asos: spec §7.1, §8 (Policies), §9, §10; yo'l xaritasi P2c va P2h qatorlari; ADR 0007, 0013, 0014.

Egasi P2c'ni savol-javobsiz, yo'l xaritasi va spec asosida loyihalashni topshirdi. Quyida "**Mening qarorim**" deb
belgilangan joylar egasi bilan kelishilmagan — ular o'qishda tekshirilishi kerak.

## 1. Maqsad va nima uchun

Hozir qurilmaga ta'sir qiluvchi yagona "siyosat" — dars overlay'i (`lesson_devices.overlay_locked` + 120 s lease).
Universitet talabi (spec §7.1) esa doim amaldagi **bazaviy siyosat**: o'qituvchi bekor qila olmaydi, Helper
qo'llaydi, davriy tekshiradi, drift topilsa qayta qo'llaydi, tarmoq uzilsa oxirgi versiya qurilmada qoladi.
P2h (talaba standart foydalanuvchi, dastur o'rnatish/o'chirish taqiqi, oboi qulfi) shu mexanizm ustiga quriladi.

P2c bitta umumiy mexanizm beradi:

1. **Ikki qatlam:** school baseline (IT admin, doimiy) va lesson policy (o'qituvchi, faqat dars lease'i ichida).
2. **Immutable versiyalar:** har o'zgarish yangi versiya; eski versiya o'zgarmaydi va audit/rollback uchun qoladi.
3. **Desired / applied / ack:** hub nima istashini, qurilma nimani haqiqatda qo'llaganini va har qoida natijasini
   alohida biladi. "30 tadan 29" umumiy muvaffaqiyatga aylanmaydi (spec §8).
4. **Birinchi haqiqiy iste'molchi — web siyosati:** managed browser extension (Chromium) dars davomida va
   bazaviy darajada URL siyosatini qo'llaydi (spec §10 oxirgi xatboshi).

Muvaffaqiyat: IT admin bazaviy siyosatni o'zgartiradi → 30 s ichida (reconcile maqsadi, spec §11) har onlayn
qurilma yangi versiyani qo'llab, ack qiladi; panelda har qurilma bo'yicha desired/applied va muvaffaqiyatsiz
qoidalar ko'rinadi. O'qituvchi darsda "faqat shu saytlar" qiladi → sinf brauzerlarida boshqa saytlar ochilmaydi;
dars tugasa yoki hub yo'qolsa 120 s ichida cheklov o'zi tushadi, bazaviy siyosat qoladi.

## 2. Maqsadlar, maqsad emas, anti-maqsadlar

**Maqsadlar**
- `policy_versions`, `policy_assignments`, `policy_receipts` (spec §8) va ularning versiyalangan zod sxemasi.
- Bazaviy siyosat: tashkilot va site darajasida; samarali (effective) siyosat qurilma uchun hub'da hisoblanadi.
- Lesson policy: dars ichida o'qituvchi beradi, mavjud overlay lease mexanizmi bilan bir xil umr.
- Qurilma API: desired siyosatni olish va receipt (applied + qoida natijalari) yuborish; o'zgarish haqida
  heartbeat javobida faqat versiya ishorasi.
- Companion: siyosatni oladi, keshlaydi, web qismini extension'ga beradi, receipt yuboradi.
- Helper (Windows): bazaviy siyosatni o'zi oladi, oflayn keshlaydi; P2c'da faqat brauzer boshqaruv siyosatlarini
  (extension majburiy o'rnatilishi, incognito/devtools o'chirilishi) qo'llaydi va drift'ni qayta qo'llaydi.
- Managed browser extension (MV3) Chrome va Edge uchun: URL allow/block, bloklangan sahifa ekrani, holatni
  Companion'ga xabar qilish.
- Web panel: IT admin bazaviy siyosat muharriri va versiyalar tarixi; o'qituvchi dars web rejimi; qurilma
  bo'yicha siyosat holati.

**Maqsad emas (keyingi bosqichlar)**
- P2h OS qoidalarining o'zi (standart foydalanuvchi, AppLocker/WDAC, oboi). P2c sxemada ularga joy qoldiradi,
  qurilma esa ularni `unsupported` deb receipt qiladi.
- Xona/qurilma darajasidagi bazaviy override, guruhlar, jadval bo'yicha siyosat.
- Firefox va boshqa Chromium bo'lmagan brauzerlar; macOS/Linux/ChromeOS extension yetkazish.
- DNS/tarmoq darajasidagi filtr (spec §10: alohida integratsiya).
- Ilova (process) bloklash ro'yxati darsda.

**Anti-maqsadlar (texnik ishlasa ham muvaffaqiyatsizlik)**
- O'qituvchi bazaviy cheklovni bo'shata olishi (spec §10: teacher baseline'ni bekor qilolmaydi).
- Dars cheklovining hub yo'qolganda yoki rebootdan keyin "qotib qolishi" (spec §10, monotonic lease).
- Qurilma "applied" deb aytib, haqiqatda qo'llamagan bo'lishi — ack faqat tekshirilgan natija.
- Siyosat hujjatida erkin skript/buyruq (spec §9: teacher API'da arbitrary shell yo'q). Qoidalar faqat
  sxemadagi tiplangan maydonlar.
- Talabaning extension'ni o'chirib, incognito yoki boshqa profil orqali filtrdan qochishi va bu panelda
  "hammasi yaxshi" bo'lib ko'rinishi.

## 3. Cheklovlar

- CLAUDE.md qattiq qoidalari: har yozuvda `organization_id` (+ `site_id` kerak joyda), TLS fail-closed,
  private kalit repoda yo'q, capability matrix'da dalilsiz `passed` yo'q.
- Qurilma so'rovlari mavjud imzo formati bilan (`NSDEV1`, Ed25519); bazaviy siyosatni Helper o'z kaliti bilan
  oladi (`x-ns-signer: helper`), Companion — qurilma kaliti bilan.
- Lesson policy umri overlay **qulfidan mustaqil** (**mening qarorim**): ekran ochiq darsda ham "faqat shu
  saytlar" ishlaydi. Lease qurilmaning faol dars a'zoligiga bog'liq (heartbeat'dagi mavjud lesson lease) va
  overlay bilan bir xil parametrlarda: 120 s lease, 30 s yangilanish, monotonic timer, rebootda qayta
  qo'llanmaydi (spec §10).
- Bazaviy siyosat oflayn saqlanadi: Helper'da `%ProgramData%\NetSchool\helper\` (ACL'li, mavjud DirGate),
  Companion'da SQLite keshi.
- Rollar: bazaviy siyosatni `school_admin` (tashkilot va istalgan site) va `it_support` (o'z site'i) o'zgartiradi;
  lesson policy'ni faqat dars o'qituvchisi (mavjud `authorize` qoidalari bilan); `student` — hech narsa.

## 4. Qaror qilingan "qanday"

### 4.1. Siyosat hujjati (packages/contracts)

`policyDocumentSchema` — `schemaVersion: 1`, tiplangan qoidalar, noma'lum kalit rad etiladi (`strictObject`).

```ts
// bazaviy qatlam
{
  schemaVersion: 1,
  web: { blocked: UrlPattern[] },                    // har doim bloklangan (mas. qimor, proxy)
  browser: {
    managed: boolean,                                // extension majburiy + quyidagilar Helper orqali
    incognito: 'allowed' | 'disabled',
    devTools: 'allowed' | 'disabled',
  },
  os: {                                              // P2h to'ldiradi; P2c'da qurilma 'unsupported' deydi
    standardUser?: boolean, blockAppInstall?: boolean, lockWallpaper?: boolean,
  },
}
// dars qatlami
{
  schemaVersion: 1,
  web: { mode: 'off' | 'allowlist' | 'blocklist', patterns: UrlPattern[] },
}
```

`UrlPattern` — sxemasiz host (+ ixtiyoriy yo'l prefiksi), subdomen uchun `*.` prefiksi; IDN punycode'ga
normallashtiriladi; regex yo'q. Ro'yxatlar soni va uzunligi chegaralangan (aniq qiymat — builder).

### 4.2. Qatlamlarni birlashtirish

Qurilma uchun effective siyosat hub'da hisoblanadi: `org baseline ⊕ site baseline ⊕ lesson`.
**Mening qarorim:** har qoida bo'yicha "qattiqrog'i yutadi":
- `web.blocked` — birlashma; bazaviy bloklangan sayt dars allowlist'ida bo'lsa ham bloklanadi.
- `browser.*`, `os.*` — `disabled`/`true` yutadi; site tashkilot cheklovini bo'shata olmaydi.
- Dars `allowlist` — bazaviy blocklist'dan keyin qo'llanadi (kesishma), `blocklist` — bazaviyga qo'shiladi.

Natija qurilmaga alohida qatlamlar sifatida (baseline va lesson, har biri o'z versiyasi bilan) va birlashgan
ko'rinishda yuboriladi: receipt har qatlam versiyasini alohida tasdiqlaydi.

### 4.3. Ma'lumot modeli (apps/api)

- `policy_versions` — immutable: `id`, `organization_id`, `site_id` (null — tashkilot), `layer`
  (`baseline`|`lesson`), `lesson_id` (faqat lesson), `version` (qatlam+ko'lam ichida monoton), `document` jsonb,
  `content_hash` (kanonik JSON sha256), `created_by`, `created_at`. UPDATE/DELETE yo'q (DB triggeri yoki
  hech qanday kod yo'li — builder tanlaydi).
- `policy_assignments` — ko'lamning joriy versiyasi: baseline uchun `(organization_id, site_id)` → `version_id`;
  lesson uchun `lesson_id` → `version_id`. Almashtirish bitta tranzaksiyada + audit + outbox voqeasi.
- `policy_receipts` — har qurilma, qatlam va xabar beruvchi (`companion`|`helper`) uchun bitta qator
  (**mening qarorim**: ikkisi bir-birini bosmasin): `desired_version_id`, `applied_version_id`, `status`
  (`applied`|`partial`|`failed`|`pending`), `rules` jsonb (qoida → `applied`|`failed`|`unsupported` + kod),
  `ack_at`. Panel holati: qatlam `applied` faqat shu qatlam uchun kutilgan har xabar beruvchi (bazaviy — Helper
  va Companion, dars — Companion) joriy versiyani `applied` qilgan bo'lsa; bittasi yo'q yoki eski bo'lsa —
  `pending`/`partial`.
- Rollback = eski versiya mazmunidan yangi versiya yaratish (tarix chiziqli qoladi).

### 4.4. API

Panel (inson):
- `GET/PUT /api/v1/policies/baseline?siteId=` — joriy versiya / yangi versiya (`If-Match` versiya bilan, yo'qolgan
  yangilanishdan himoya). `GET .../baseline/versions` — tarix. `POST .../baseline/versions/{id}/restore`.
- `PUT /api/v1/lessons/{lessonId}/policy` — spec §9'dagi yo'l; yangi lesson versiya.
- `GET /api/v1/policies/status?roomId=|siteId=` — qurilmalar bo'yicha desired/applied/xato qoidalar.

Qurilma:
- Heartbeat javobi `policy: { baselineVersion, lessonVersion | null }` ishorasini oladi (mavjud lesson lease
  yonida). O'zgarsa qurilma to'liq hujjatni oladi.
- `GET /api/v1/device/policy` va `PUT /api/v1/device/policy/receipt` — Companion (qurilma kaliti): effective
  siyosat (qatlamlar + versiyalar + lesson lease muddati) va receipt.
- `GET /api/v1/device/helper/policy` va `PUT /api/v1/device/helper/policy/receipt` — Helper (helper kaliti), faqat
  bazaviy qatlam. **Mening qarorim:** ADR 0014'dagi "helper kaliti faqat `/device/helper/*`da" qoidasi
  bo'shatilmaydi, Helper uchun alohida yo'llar qo'shiladi.
- Eski versiya receipt'i yangisini bosmaydi (monotonlik tekshiruvi).

### 4.5. Qurilmada kim nima qiladi

- **Helper (SYSTEM, Windows):** bazaviy siyosatni o'zi oladi (Companion'ga ishonmaydi), oflayn keshlaydi,
  `browser.*` qoidalarini HKLM brauzer siyosatlari orqali qo'llaydi (`ExtensionInstallForcelist`,
  `IncognitoModeAvailability`, `DeveloperToolsAvailability`, Chrome va Edge uchun), davriy (60 s) tekshiradi va
  drift'ni qayta qo'llab audit voqeasi yuboradi; `os.*` uchun `unsupported` receipt.
- **Companion:** ikkala qatlamni oladi, lesson lease'ini mavjud overlay lease kabi yuritadi, web qoidalarini
  extension'ga beradi, extension holatini (ulangan/yo'q, versiya) receipt'ga qo'shadi.
- **Extension (MV3, `extensions/browser/`):** `declarativeNetRequest` dinamik qoidalari bilan bloklash, bloklangan
  sahifa (uz/ru/en), siyosatni Companion'dan **native messaging** orqali oladi (Helper HKLM'da host'ni
  ro'yxatdan o'tkazadi). Companion bilan aloqa yo'q bo'lsa — oxirgi bazaviy qoidalar qoladi, lesson qoidalari
  lease tugaganda tushadi (extension ham monotonic expiry'ga amal qiladi).
- **Capability:** `web.filter` (`provider: managed_extension`) faqat extension ulangan va Helper brauzer
  siyosatlari qo'llangan bo'lsa `available`; aks holda sababi bilan.

### 4.6. Qochish yo'llari va ularning holati

- Extension'ni o'chirish → force-install siyosati bilan o'chirib bo'lmaydi; Helper drift'ni qayta qo'llaydi.
- Incognito / devtools → bazaviy `browser` qoidalari.
- Boshqa brauzer (Firefox, portable Chromium) → P2c'da faqat aniqlanadi va receipt'da `web.filter: partial`
  (sabab `unmanaged_browser`); bloklash P2h ilova allowlist'i (AppLocker/WDAC) bilan.
- Proxy/VPN extension → force-install'dan tashqari extension'lar `ExtensionInstallBlocklist: *` bilan (bazaviy
  `browser.managed` ichida).

### 4.7. Talaba hali lokal admin bo'lsa

**Mening qarorim:** P2c kodi P2h'gacha ham ishlaydi, lekin lokal admin talaba HKLM kalitlarini va native
messaging host'ni o'chira oladi; 60 s drift tekshiruvi buni faqat qisqartiradi. Shuning uchun qabul sinovi va
capability matrix'dagi har `passed` ADR 0014 kabi **standart foydalanuvchi** akkauntida o'tkaziladi. Buzish
(kalit yo'qolgani, host o'chirilgani) receipt'da sababi bilan ko'rinadi va audit qilinadi.

## 5. Builder'ga qoldirilganlar

- Jadval ustunlari va indekslarning aniq nomlari, migratsiya bo'linishi; immutability qanday ta'minlanishi.
- Ro'yxat chegaralari (qoida soni, pattern uzunligi), kanonik JSON algoritmi.
- Heartbeat'dagi ishora formati va Companion/Helper so'rov tezligi (reconcile ≤30 s maqsadiga mos).
- Panel UI tafsilotlari (mavjud shadcn komponentlari, uz/ru/en).
- Extension ichki tuzilishi va bloklangan sahifa dizayni.
- Testlar: PGlite API testlari, Companion core unit testlari, Go Windows testlari CI'da, extension uchun
  Playwright (agar amaliy bo'lsa).

## 6. Egasi qarorlari (2026-11-12)

- **Extension yetkazish:** Chrome Web Store va Edge Add-ons'ga **unlisted** chiqariladi; `ExtensionInstallForcelist`
  do'kon ID'si va do'kon update URL'i bilan (domain/CBCM shart emas). Natija: extension ID'lari do'kon beradi va
  qat'iy; do'konga yuklash (Google developer akkaunti, Edge Partner Center, tekshiruv kunlari) egasining qo'lda
  bajariladigan qadami — rejada alohida bosqich va runbook. Ishlab chiqish va CI'da extension unpacked holda
  yuklanadi; siyosat kodida ID'lar konfiguratsiya (hub'dan yoki build'da), qattiq kodlanmaydi. Imzolash kaliti
  do'konlarda — repoda va hub'da private kalit yo'q.
- **Qo'llab-quvvatlanadigan brauzerlar:** Google Chrome va Microsoft Edge. Yandex Browser, Firefox va boshqalar
  P2c'da `unmanaged_browser` sifatida aniqlanadi va receipt'da `web.filter: partial` bo'ladi; bloklash P2h ilova
  allowlist'ida.

## 7. Builder tekshiruvidan keyingi qarorlar (mening qarorim)

- Helper uchun alohida `/device/helper/policy*` yo'llari (ADR 0014 chegarasi saqlanadi) — §4.4.
- Receipt har xabar beruvchi uchun alohida qator; panel ularni birlashtiradi — §4.3.
- Lesson web siyosati overlay qulfidan mustaqil, dars a'zoligi lease'iga bog'liq — §3.
- Qabul sinovi standart foydalanuvchi akkauntida; lokal admin buzishi receipt/audit'da ko'rinadi — §4.7.
- Qatlamlarni birlashtirish: qattiqrog'i yutadi — §4.2.
