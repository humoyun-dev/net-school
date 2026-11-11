# ADR 0014: Windows OS helper (SYSTEM xizmati) — arxitektura va cheklovlar

Sana: 2026-11-11 · Holat: qabul qilingan (qo'lda qabul sinovi kutilmoqda) · Kontekst: P2d1 · Reja: [p2d1-windows-helper](../superpowers/plans/2026-11-09-p2d1-windows-helper.md) · Oldingi: [ADR 0013](0013-windows-hard-lock-results.md) · Qabul sinovi: [runbook va natija jadvali](../poc/results/windows-x64-2026-11-11-helper-manual.md)

## Kontekst

ADR 0013 ko'rsatdiki, o'quvchi huquqidagi Companion kuchli bloklashni ta'minlay olmaydi: `HKCU\...\Policies`ga faqat admin/SYSTEM yozadi, Ctrl+Alt+Del foydalanuvchi rejimidagi hook bilan to'silmaydi, o'quvchi Companion'ni Vazifalar menejeridan yopadi. Egasining talablari: bloklashda Ctrl+Alt+Del umuman ishlamasin, bloklashda dastur ochilmasin, o'quvchi kompyuteridagi agent SYSTEM darajasida ishlasin va yopib bo'lmasin. P2d1 Go'dagi `native/helper` (`netschool-helper.exe`) ni qurdi. Bu ADR uning qarorlarini va ma'lum cheklovlarini qayd etadi.

## Qarorlar

### 1. Arxitektura

- **Xizmat.** `NetSchoolHelper` (`NetSchool Helper`), `Automatic`, SYSTEM, session 0. Xizmat DACL: oddiy (interaktiv yoki xizmat) foydalanuvchi faqat holatni ko'radi, to'xtata/o'chira olmaydi (`D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)`). Qulasa qayta ishga tushadi: 1 s, 1 s, 5 s (hisoblagich 86400 s da nollanadi).
- **Guard.** Xizmat o'quvchi sessiyasida SYSTEM tokeni bilan oynasiz `guard` jarayonini ishga tushiradi. Unda faqat low-level klaviatura hook'i bor. O'quvchi SYSTEM jarayonini yopa olmaydi. Xizmat va guard faqat SYSTEM kira oladigan nomli pipe (`\\.\pipe\netschool-helper-guard`, `D:P(A;;GA;;;SY)`) orqali gaplashadi. Pipe nomi hech qachon bo'sh qolmaydi (begona jarayon uni egallay olmaydi), ikki tomon ham narigi tomon SYSTEM ekanini tekshiradi.
- **Helper'ning o'z kaliti.** Helper hub'dan bloklash holatini Companion orqali emas, o'z Ed25519 kaliti bilan oladi (`x-ns-signer: helper`, imzo formati Companion'niki bilan bir xil). Hub imzolovchini yo'l bo'yicha tekshiradi: helper kaliti faqat `/api/v1/device/helper/*` yo'llarida, Companion kaliti faqat Companion yo'llarida o'tadi. Replay himoyasi uchun timestamp hisoblagichlari alohida (`last_signed_ts`, `helper_last_signed_ts`), shuning uchun ikki mijoz bir-birini bloklamaydi.
- **Claim.** Enrollment claim'ida ixtiyoriy `helperPublicKey` + `helperProof` (helper kaliti bilan imzolangan `NSCLAIM1\n<token>\n<helperPublicKey>`). Ikkalasi birga keladi yoki umuman kelmaydi.
- **Helper holati.** Helper komponentlar holatini `PUT /api/v1/device/helper/status` bilan yuboradi. Hub faqat oxirgisini va qabul vaqtini saqlaydi (`devices.helper_status`, `helper_status_at`), har hisobotga audit yozmaydi.
- **Panel darajasi.** Hub `classroom.overlay` darajasini helper holatidan hisoblaydi (saqlangan Companion hisoboti o'zgarmaydi):
  - helper hisoboti ≤ 90 s eski bo'lsa: `hard` faqat `hook`, `policy`, `processGuard` uchalasi `active` bo'lganda. Aks holda `soft` + birinchi yiqilgan komponent (`hook_failed` | `policy_failed` | `process_guard_failed`). Yiqilgan komponent yo'q, lekin hammasi `active` ham emas (bloklash yo'q, komponentlar `off`) bo'lsa `soft` + `lock_inactive`: kuchli bloklash hali isbotlanmagan;
  - helper hisoboti yo'q yoki eski bo'lsa: Companion hisoboti, lekin hech qachon `hard` emas (`hard` → `soft` + `helper_missing`). Companion yolg'iz o'zi `soft` (2-band).
- **`classroom.sas_block`.** Yangi capability, faqat hub hisoblaydi (Companion yuborgani e'tiborsiz qoldiriladi), faqat Windows qurilmalarida: `cad=blocked|off` → `available`; `unavailable` → `unsupported` (`reason: edition`); `failed` → `unsupported` (`reason: failed`); helper hisoboti yo'q/eski → `unsupported` (`reason: helper_missing`). Shu uchun capability nomlarida segment ichidagi `_` ruxsat etildi (`packages/contracts`).

### 2. Injected tugmalar (avvalgi qoidadan chetlanish)

P2d0'da (ADR 0013) "injected hodisalar to'silmaydi" qoidasi bor edi. P2d1'da qoida: injected tugma faqat `LLKHF_LOWER_IL_INJECTED` bitisiz bo'lsa o'tadi. MeshAgent (SYSTEM) orqali o'qituvchining masofaviy boshqaruvi o'tadi; o'quvchining o'rta darajadagi (medium IL) jarayonidan `SendInput(Win)` endi SYSTEM guard'da to'siladi. Companion'ning o'z hook'i o'rta darajada ishlaydi va o'quvchi `SendInput`ini MeshAgent kiritishidan ajrata olmaydi. Shuning uchun Companion yolg'iz o'zi har doim `soft`.

### 3. Companion kuzatuvchisi (supervisor)

Helper Companion'ni o'quvchi tokeni bilan, guard'ni SYSTEM tokeni bilan ishga tushiradi va kuzatadi. Jarayon `StartupCrashWindow` (5 s) dan kam yashasa, bu "ishga tushishda yiqilish": kutish 1 s, 2 s, 4 s … 30 s gacha oshadi. Aks holda 1 s dan keyin qayta ishga tushadi. Bu rejadagi "≥ 60 s yashasa nollanadi" dan chetlanish: o'quvchi o'ldirgan Companion ≤ 3 s da qaytishi kerak. Qolgan xavf: o'quvchi Companion'ni har qayta ishga tushgandan keyin 5 s ichida o'ldirib tursa, kutish 30 s gacha oshadi. Bu qabul qilinadi: kuchli bloklash (guard, siyosat, process guard, CAD) Companion'ga bog'liq emas, faqat overlay matni kechikadi.

### 4. Process guard

Bloklash boshlanganda o'quvchi sessiyasidagi jarayonlar baseline sifatida olinadi. Har 250 ms:

- boshqa sessiya, PID 0/4 → tegilmaydi;
- `%ProgramFiles%\NetSchool\`, `%ProgramFiles%\Mesh Agent\` ichidagi yoki ruxsat ro'yxatidagi tizim jarayonlari (`System32` dagi `conhost`, `dwm`, `csrss`, `fontdrvhost`, `ctfmon`, `LogonUI`, `consent`, `WerFault`, `SystemSettingsBroker`; `TextInputHost`) → tegilmaydi;
- `System32\taskmgr.exe` → baseline'da bo'lsa ham o'ldiriladi;
- baseline'dagi jarayon → yashaydi (o'quvchining ochiq ishi);
- baseline'da bo'lmagan jarayon faqat **bir xil dastur avlodi** bo'lsa yashaydi: ota zanjiri tirik baseline ajdodga yetadi va zanjirdagi hamma jarayon aynan shu exe (masalan, brauzerning yangi tablari). Rejadagi "baseline avlodi, explorer/taskmgr/sihost/RuntimeBroker'dan keyin emas" qoidasi shu bilan almashtirildi;
- qolgani o'ldiriladi. Toolhelp ota PID'i eskirgan (PID qayta berilgan yoki snapshot paytida yaratilgan) jarayon bir skan o'tkazib yuboriladi.

Ma'lum qoldiqlar: foydalanuvchi yoza oladigan joydagi baseline exe o'zini qayta ishga tushirib yashay oladi; `SysWOW64\Taskmgr.exe`, Process Explorer va baseline PowerShell yashaydi (Ctrl+Shift+Esc hook'da to'siladi, lekin oldindan ochilgani qoladi); 8.3 qisqa yo'llar normallashtirilmaydi; birinchi `Start` yiqilsa baseline 30 s dagi qayta urinishda olinadi. Qaysi shell/UWP jarayonlari (RuntimeBroker, SearchHost, TextInputHost, StartMenuExperienceHost, dllhost) o'ldirilishi qabul sinovida yoziladi, kerak bo'lsa ruxsat ro'yxati kengaytiriladi.

### 5. Ctrl+Alt+Del (CAD)

Keyboard Filter (`WEKF_PredefinedKey` `Ctrl+Alt+Del`, `Win+L`) faqat Education, Enterprise va IoT Enterprise nashrlarida. Funksiya o'chiq ("Disabled") bo'lsa ham `edition` deb hisoblanadi. Bloklashdan oldin jurnal yoziladi. Bloklash yo'q paytda jurnalda qolgan filtr har 30 s qayta ochishga uriniladi. Pro/Home'da Ctrl+Alt+Del ekrani ochiladi, lekin unda siyosat tufayli faqat «Отмена» qoladi. Egasining ochiq qarori o'zgarmagan: (a) laboratoriyalarni Windows Education'ga o'tkazish yoki (b) attestatsiya imzoli kernel klaviatura filtr drayveri (alohida reja P2d2).

### 6. Ma'lumot va sozlama

- Helper faqat `%ProgramData%\NetSchool\helper` ni ishlatadi: ACL faqat SYSTEM va Administrators (o'qish ham), meros olinmaydi (protected DACL), egasi `BA`. Fayllar: `helper.key`, `device.json`, `hub-ca.pem`, `lock.json`, `policy-journal.json`, `cad-journal.json`.
- ACL handle orqali qo'yiladi (reparse point va hardlink kuzatilmaydi). Oldindan mavjud ishonchsiz katalog (masalan, o'quvchi yaratgan `%ProgramData%\NetSchool`, Companion enrollment'i bilan birga) o'chirib qayta yaratiladi.
- Katalog tekshiruvdan o'tmasa helper hub'ga ulanmaydi (bloklash yo'q, ochiq) va har 60 s qayta tekshiradi. Ishonchsiz sozlama umuman o'qilmaydi.
- Qolgan xavf: o'quvchi faylga handle ushlab tursa, himoyalashni faqat u tizimda bo'lgan paytda to'sa oladi. Xizmat boot paytida (o'quvchi kirishidan oldin) himoyalaydi.

### 7. Enroll va migratsiya

- `enroll.cmd`: Companion `enroll` helper kalitini `netschool-helper helper-key` bilan helper katalogida yaratadi (token stdin orqali), claim'dan keyin `set-hub` bilan hub manzili va CA'ni beradi (CA stdin orqali), so'ng `install`. Enroll helper kalitini hech qachon o'zi yozmaydi.
- P2d1'dan oldin ro'yxatdan o'tgan kompyuterlar `enroll.cmd --force` va yangi token bilan qayta o'tkaziladi (helper kaliti yangilanadi). Hub'da eski qurilma yozuvi qoladi, uni admin retire qiladi.
- `set-hub`dan keyin xizmatni qayta ishga tushirish kerak (`install` buni qiladi).
- `uninstall.cmd` faqat paket katalogidan ishga tushiriladi (o'rnatilgan nusxa o'zini o'chira olmaydi).

### 8. Hub API

Claim xatolari: helper kaliti yoki proof noto'g'ri → `400 validation_failed`; audit sabablari `invalid_helper_key`, `invalid_helper_proof`. Boshqa qurilmada ro'yxatdan o'tgan helper kaliti → `409`.

### 9. Release sharti

O'zgarmagan: qo'lda qabul sinovi ([runbook](../poc/results/windows-x64-2026-11-11-helper-manual.md)) standart (admin emas) o'quvchi hisobida o'tmaguncha helper release qilinmaydi va matrix'da hech narsa `passed` deb belgilanmaydi.

## Oqibatlar

- Panel "kuchli" faqat helper buni yaqinda (≤ 90 s) tasdiqlaganda ko'rsatadi. Helper o'chsa yoki hub'ga yetmasa, daraja 90 s ichida `soft`ga tushadi.
- Companion overlay va UI bo'lib qoladi. Bloklashning majburlovchi qismi o'quvchi huquqidan tashqarida.
- Pro/Home'da Ctrl+Alt+Del ekrani hali ochiladi (`classroom.sas_block: unsupported, edition`).

## Ochiq qolganlar

- Qo'lda qabul sinovi (Task 12 Step 2) — egasi o'tkazadi.
- Ctrl+Alt+Del: Education yoki P2d2 drayveri (egasi qarori).
- `CreateProcessAsUser` 1314 bilan yiqilsa `SeAssignPrimaryTokenPrivilege`/`SeIncreaseQuotaPrivilege` yoqish kerak bo'ladi (sinovda tekshiriladi).
- Companion ↔ helper buyruq kanali, Companion kalitini helper'ga ko'chirish, imzolangan MSI (P2e), macOS/Linux helper'lari — bu rejaga kirmaydi.
