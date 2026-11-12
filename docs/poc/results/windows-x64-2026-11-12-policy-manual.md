# Windows x64 — siyosat va brauzer extension'i qo'lda qabul sinovi (P2c, runbook)

**Natija: hali o'tkazilmagan.** To'ldirilmaguncha capability matrix'da `web.filter` `not_tested` qoladi ([ADR 0015](../../adr/0015-policy.md)).

Sana: — · Kompyuter: — · Windows nashri: — · Chrome versiyasi: — · Edge versiyasi: — · Hub: — · Extension ID'lari: — · Paket commit'i: —

## A. Egasining tayyorlov qadami: extension'ni do'konga chiqarish

1. `pnpm build:extension` → `extensions/browser/dist/`. Shu katalogni zip qiling (ichida `manifest.json` yuqori darajada).
2. **Chrome Web Store:** Google developer akkaunti (bir martalik to'lov) → Developer Dashboard → New item → zip → Visibility: **Unlisted** → ko'rib chiqishga yuborish. Ruxsatlar izohi: `declarativeNetRequest`, `webNavigation` (sayt cheklovi), `nativeMessaging` (maktab kompyuteridagi NetSchool bilan aloqa), `storage`, `alarms`.
3. **Edge Add-ons:** Microsoft Partner Center → Edge → yangi extension → o'sha zip → Visibility: **Hidden** (unlisted).
4. Tasdiqlangach do'kon bergan 32 harfli ID'larni hub muhitiga yozing: `NETSCHOOL_EXTENSION_ID_CHROME`, `NETSCHOOL_EXTENSION_ID_EDGE` (`infra/compose`), hub'ni qayta ishga tushiring.
5. Imzolash kalitini do'kon saqlaydi; repoda va hub'da extension kaliti yo'q.

## Shartlar

- Sinov **standart (admin emas) o'quvchi hisobida** (risk #17). Admin amallari alohida hisobdan; har qatorda kim bajargani yoziladi.
- Helper va Companion P2d1 runbook'i bo'yicha o'rnatilgan va ishlaydi.
- Bazaviy siyosat (panel → Siyosat, tashkilot): bloklangan `example.org`, "Brauzerlarni boshqarish", "Incognito/InPrivate rejimini o'chirish", "Dasturchi asboblarini o'chirish" yoqilgan.
- Holat: panelda kompyuter kartochkasidagi siyosat belgisi yoki `GET /api/v1/policies/status?roomId=<id>` (DevTools Console, P2d1 runbook'idagi kabi).

## Natijalar

Holat ustuni: `pending` | `ha` | `yo'q` | `qisman`. Hozir hammasi `pending`.

| # | Tekshiruv | Kutilgan | Holat | Izoh |
|---|---|---|---|---|
| 1 | Siyosat saqlangach ≤ 30 s kutish, `chrome://policy` va `edge://policy` | `ExtensionInstallForcelist`, `ExtensionInstallBlocklist`, `IncognitoModeAvailability`/`InPrivateModeAvailability`, `DeveloperToolsAvailability` ko'rinadi | pending | |
| 2 | `chrome://extensions` | NetSchool o'rnatilgan, "Administrator o'rnatgan", o'chirish/olib tashlash yo'q | pending | |
| 3 | Boshqa extension o'rnatishga urinish | Bloklangan | pending | |
| 4 | Incognito (Ctrl+Shift+N), mehmon profil, yangi profil | Hammasi yo'q | pending | |
| 5 | `https://example.org` va `https://www.example.org/a` | Bloklangan sahifa (o'zbekcha) | pending | |
| 6 | Dars boshlanadi, Web → "Faqat shu saytlar": `wikipedia.org`, `example.org` | `wikipedia.org` ochiladi; boshqa saytlar bloklangan; `example.org` bloklangan qoladi (bazaviy ustun) | pending | |
| 7 | Ekran qulfsiz holatda (6-qator davomida) | Allowlist ishlaydi (qulfga bog'liq emas) | pending | |
| 8 | Hub'ni o'chirish (dars davomida), telefon soati bilan | ≤ 120 s ichida dars cheklovi tushadi, `example.org` bloklangan qoladi | pending | |
| 9 | Dars allowlist'i paytida brauzerni yopib qayta ochish | Dars qoidalari keyingi push'gacha yo'q (Companion tirik bo'lsa ≤ 10 s ichida qaytadi) | pending | |
| 10 | Admin hisobidan `reg delete "HKLM\SOFTWARE\Policies\Google\Chrome" /v IncognitoModeAvailability /f` | ≤ 60 s ichida qaytadi; audit'da `policy.drift_repaired` | pending | |
| 11 | Firefox (yoki Yandex Browser) ishga tushirish | Panelda `Siyosat qisman`, sabab `unmanaged_browser` | pending | |
| 12 | Tarmoqni uzib kompyuterni qayta yuklash | Bazaviy blok (`example.org`) ishlaydi | pending | |
| 13 | Companion'ni yopib (admin, `taskkill`) — Helper qayta ishga tushirguncha | Extension `unavailable`; bazaviy qoidalar qoladi; ≤ 60 s'dan keyin panelda `extension_missing` emas (Companion qaytadi) | pending | |
| 14 | O'quvchi `NetSchool Companion.exe`ni `ELECTRON_RUN_AS_NODE=1` bilan o'zi ishga tushirib pipe ochishga urinadi | Host unga ulanmaydi (haqiqiy Companion ishlayotgan bo'lsa nom band; bo'lmasa host rad etadi) | pending | |
| 15 | Edge'da 5–6-qatorlar | Chrome bilan bir xil | pending | |
| 16 | Panel: ikki admin bir vaqtda saqlaydi | Ikkinchisiga "Boshqa admin siyosatni o'zgartirdi" | pending | |
| 17 | Panel: versiyalar → "Tiklash" | Yangi versiya, kompyuterlar ≤ 30 s ichida qo'llaydi | pending | |
