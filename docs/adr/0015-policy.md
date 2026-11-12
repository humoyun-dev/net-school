# ADR 0015: Siyosat qatlamlari, immutable versiyalar, receipt'lar va managed brauzer extension'i

Sana: 2026-11-12 · Holat: qabul qilingan (qo'lda qabul sinovi va do'konga chiqarish kutilmoqda) · Kontekst: P2c · Dizayn: [p2c-policy-design](../superpowers/specs/2026-11-12-p2c-policy-design.md) · Reja: [p2c-policy](../superpowers/plans/2026-11-12-p2c-policy.md) · Oldingi: [ADR 0014](0014-windows-helper.md) · Qabul sinovi: [runbook](../poc/results/windows-x64-2026-11-12-policy-manual.md)

## Kontekst

Spec §7.1 va §10 doim amaldagi bazaviy siyosatni talab qiladi: uni o'qituvchi bekor qila olmaydi, Helper qo'llaydi va drift'ni tuzatadi, tarmoq uzilsa oxirgi versiya qurilmada qoladi. Dars cheklovi esa faqat dars lease'i ichida turadi. P2h (OS cheklovlari) shu mexanizm ustiga quriladi. Egasi qarorlari (2026-11-12): extension Chrome Web Store va Edge Add-ons'ga unlisted chiqariladi; qo'llab-quvvatlanadigan brauzerlar — Google Chrome va Microsoft Edge.

## Qarorlar

### 1. Qatlamlar va birlashtirish

- **Bazaviy qatlam** — tashkilot va site darajasida (`policy.manage`: `school_admin` hamma joyda, `it_support` o'z site'ida). **Dars qatlami** — faol dars ichida (`lesson.policy`: dars egasi o'qituvchi va site admin).
- Qurilma uchun effective siyosat: `tashkilot ⊕ site ⊕ dars`, **qattiqrog'i yutadi** (`packages/domain/src/policy/merge.ts`). Bloklangan ro'yxatlar birlashadi; `managed`/`os.*` `true`, `incognito`/`devTools` `disabled` yutadi. Dars allowlist'i bazaviy blokni ochmaydi.
- Dars web siyosati overlay qulfidan mustaqil: qurilma faol dars a'zosi ekan amalda; lease 120 s, monotonic, rebootda qaytmaydi.

### 2. Versiyalar

- `policy_versions` immutable: UPDATE/DELETE DB triggeri bilan rad etiladi (`0015_policy_immutable.sql`). Rollback = eski mazmundan yangi versiya (`restored_from`).
- `policy_assignments` — har ko'lamning joriy versiyasi. Yozish `If-Match: <joriy versiya | 0>` bilan, mos kelmasa `409 conflict` (yo'qolgan yangilanish yo'q). Bir xil mazmun yangi versiya yaratmaydi.
- Har o'zgarish audit'da (`policy.baseline_changed`, `policy.lesson_changed`).

### 3. Yetkazish va receipt'lar

- Companion: `GET /api/v1/device/policy`, `PUT /api/v1/device/policy/receipt`. Helper (o'z kaliti): `GET /api/v1/device/helper/policy`, `PUT /api/v1/device/helper/policy/receipt` — ADR 0014'dagi "helper kaliti faqat `/device/helper/*`da" chegarasi saqlanadi.
- O'zgarish haqida ishora: heartbeat javobida `policy` (`{baseline:{org,site}, lesson}`), Helper uchun `lock-state`dagi `baseline`. Qurilma to'liq hujjatni faqat ishora o'zgarganda oladi.
- `policy_receipts` kaliti `(qurilma, qatlam, xabar beruvchi)`: Helper va Companion bir-birini bosmaydi. Eski revision'li receipt yangisini bosmaydi. Panel holati har xabar beruvchining kutilgan qoidalari (`activeRules`) bo'yicha: hammasi qo'llangan — `applied`; mos receipt yo'q — `pending`; aks holda `partial`/`failed`. `unsupported` qo'llangan hisoblanmaydi.
- Helper drift'ni tuzatsa receipt'da `repaired`, hub audit yozadi (`policy.drift_repaired`).

### 4. Qurilmada

- **Helper** bazaviy siyosatni keshlaydi (`%ProgramData%\NetSchool\helper\baseline.json`, DirGate orqali) va HKLM brauzer siyosatlarini yozadi (`native/helper/internal/browser`): `ExtensionInstallForcelist` (do'kon ID'si + do'kon update URL'i), `ExtensionInstallBlocklist=*`, `BrowserGuestModeEnabled=0`, `BrowserAddPersonEnabled=0`, `NativeMessagingUserLevelHosts=0`, incognito/InPrivate va devtools, native messaging host ro'yxati. `ExtensionInstallForcelist` va `ExtensionInstallBlocklist` kalitlari to'liq Helper'niki; qolgan siyosatlarga faqat belgilangan nomlar bo'yicha tegiladi. Har 60 s qayta tekshiradi. `os.*` P2c'da `unsupported`.
- **Companion** ikkala qatlamni yuritadi va o'quvchi sessiyasidagi `\\.\pipe\netschool-web-<sessiya>` orqali web qoidalarini beradi.
- **Native messaging host** — `netschool-helper.exe` (brauzer uni `chrome-extension://<id>/` bilan ishga tushiradi). Pipe server'ga faqat u o'rnatilgan Companion exe'si, otasi ishlayotgan `NetSchoolHelper` xizmati, xizmat serverdan oldin yaratilgan va bir sessiyada bo'lsa ulanadi. Shu tekshiruv uchun xizmat o'z jarayoniga Interactive foydalanuvchilarga faqat `PROCESS_QUERY_LIMITED_INFORMATION` beradi.
- **Extension** (`extensions/browser`, MV3): `declarativeNetRequest` dinamik qoidalari (bazaviy/dars blok > allowlist ruxsati > qolgan navigatsiya), bloklangan sahifa (uz/ru/en), domain'ning kanonik mosligi bilan navigatsiya tekshiruvi (%-kodlangan yo'llar uchun; xavfsiz tomonga yopiq: blok keng shakl *yoki* qat'iy shakl mos kelsa, allowlist ikkalasi ham mos kelsa — `%2f..` allowlist'ni kengaytirmaydi). Pattern'da `.`/`..` segmentlari rad etiladi. Bazaviy qoidalar `storage.local`da, dars qoidalari `storage.session`da (brauzer qayta ochilsa yo'qoladi). `applied` faqat qoidalar o'rnatilgani tekshirilgach yuboriladi.
- Capability `web.filter` (`provider: managed_extension`): so'nggi 60 s ichida extension ulangan bo'lsa `available`, aks holda `requires_setup` (`extension_missing`).

## Qoldiq risklar

1. **P2h'gacha lokal admin talaba** HKLM kalitlarini va host'ni o'chira oladi; 60 s drift tekshiruvi buni qisqartiradi va audit'da ko'rinadi. Qabul sinovi standart foydalanuvchida (risk #17).
2. **Soxta `applied`.** Web pipe'ga bir xil foydalanuvchining istalgan jarayoni ulanishi mumkin: Companion bir xil foydalanuvchi mijozini farqlay olmaydi. Bu faqat panelga yolg'on holat beradi — majburlashni (force-install extension) o'chirmaydi. P2h ilova allowlist'i skript ishga tushirishni yopadi.
3. **Boshqarilmaydigan brauzerlar** nom bo'yicha aniqlanadi (`firefox.exe`, `browser.exe`, Program Files'dan tashqaridagi `chrome.exe`/`msedge.exe` …); boshqa nomga o'zgartirilgan brauzer ko'rinmaydi. Bloklash P2h'da.
4. **Sub-frame'lar** faqat DNR regex'i bilan; %-kodlangan yo'lli iframe yo'l bo'yicha blokdan o'tishi mumkin (host bo'yicha blok to'liq ishlaydi).
5. Do'konga chiqarilmaguncha forcelist yozilmaydi: `browser.managed` — `failed/extension_unpublished`.
