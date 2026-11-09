# Windows x64 — kuchli bloklash qo'lda sinovi (P2d0 T6, 2026-11-09)

Windows 11 (rus tili) · Lenovo LOQ 15IRX9 (`DESKTOP-NAF58T0`), foydalanuvchi `lenovo` (**administrator**) · Ethernet · hub: Mac'da compose (`https://10.10.0.102`, yangi `netschool-poc` stack) · Companion: portable zip (`pack-win`), Electron 45.2.1, koffi 3.3.6

Avtomatik tekshiruv: `windows-x64-2026-11-09-hard-lock-verify.json` (8/8). Undagi `classroom.overlay: hard` hali bloklash qo'llanmagan paytdagi hisobot, u kuchli bloklash ishlaganining dalili emas (pastda 5-topilma).

Bloklash `overlay.lock` buyrug'i bilan yuborildi (o'quvchining o'z klaviaturasi bilan sinaldi). Laptop soati Mac/hub'dan ~1 daq 45 s oldinda edi.

## Natijalar (yakuniy build: hook alohida oqimda)

| # | Band | Natija | Izoh |
|---|---|---|---|
| 1 | Daraja | qisman | Capability `soft`, sabab `policy_failed`: hook o'rnatiladi, siyosat yozilmaydi (pastda 3-topilma) |
| 2 | Win, Ctrl+Esc, Alt+Tab, Alt+F4, Alt+Space, Ctrl+Shift+Esc | ha | Ko'p marta ketma-ket bosilganda ham to'siladi |
| 3 | Ctrl+Alt+Del, Win+L | yo'q | Ctrl+Alt+Del ekranida barcha bandlar bor (Vazifalar menejeri ham). O'quvchi Vazifalar menejeri orqali Companion'ni yopdi va bloklash paytida dastur ishga tushirdi. Hook SAS'ni ushlay olmaydi, siyosat SYSTEM huquqini talab qiladi |
| 4 | Bloklash paytida o'qituvchining masofaviy boshqaruvi | ha | Sichqoncha va klaviatura ishladi (injected kiritish to'silmaydi) |
| 5 | Ochish | ha | Ochishdan keyin Win, Alt+Tab, Ctrl+Shift+Esc odatdagidek |
| 6 | Hub API to'xtatildi | qisman | Overlay o'zi tushdi, tugmalar qaytdi; API qaytgach bloklash qaytdi. Tushish vaqti aniq o'lchanmadi (laptop soati farqi; javob API to'xtagandan ~35 s da keldi). Kod bo'yicha lease 120 s, 2026-11-03 da ≈120 s o'lchangan; qayta o'lchash kerak |
| 7 | Companion bloklash paytida o'ldirildi (Vazifalar menejeri) | ha | Overlay va hook u bilan birga yo'qoldi; `start.cmd` dan keyin bloklash qaytdi |
| 8 | Bloklangan holda reboot | qisman | Companion ~32 s da qayta ulandi (HKLM Run), MeshAgent o'zi ishga tushdi, bloklash qaytdi, Win to'sildi. O'qituvchi matni ko'rinmadi (risk #15) |

## Sinovda topilgan muammolar

| # | Topilma | Dalil | Holat |
|---|---|---|---|
| 1 | Windows paketida koffi yo'q edi (paket `node_modules` ni olmasdi): hook hech qachon yuklanmasdi | Zip tarkibi | Tuzatildi: `pack-win` koffi va `@koromix/koffi-win32-<arch>` ni qo'shadi, yo'q bo'lsa yig'ilmaydi |
| 2 | Har 30 s dagi `retryRestore` faol bloklashni "qolib ketgan siyosat" deb olib tashlardi (hook, siyosat, xato holati) | Bloklashdan >30 s keyin registry bo'sh, panel "hard"; test takrorladi | Tuzatildi: faol bloklashga tegmaydi (test bilan) |
| 3 | `HKCU\...\Policies` ga oddiy jarayon yoza olmaydi («Отказано в доступе»); faqat admin/SYSTEM | Oddiy cmd'da `reg add` | Siyosat P2d SYSTEM helper'ga o'tadi (ADR 0013). Ijobiy tomoni: o'quvchi ham bu qiymatlarni o'zgartira olmaydi |
| 4 | Hook Electron asosiy oqimida: birinchi bosish to'silib, keyingilari o'tardi. Windows sekin hook'ni olib tashlaydi (`LowLevelHooksTimeout`), asosiy oqim miniatura bilan band | Takroriy bosish | Tuzatildi: hook alohida worker oqimida (`GetMessageW` sikli); oqim o'lsa `hook_failed` |
| 5 | `facts()` bloklash urinishi bo'lmasa ham `enforced: true`: bo'sh holatda va qayta ishga tushganda capability "hard" | `verify` va reboot'dan keyingi hisobot | Ochiq: holat oxirgi haqiqiy urinishdan olinishi kerak |
| 6 | MeshAgent xizmati o'z-o'zidan to'xtab qoldi (10:14 dan keyin, `STOPPED`, chiqish kodi 0, jurnalda to'xtatish yozuvi yo'q) | `sc query`, System jurnali | Ochiq kuzatuv: `sc start` bilan qaytdi; reboot'dan keyin avtomatik ishga tushdi |
| 7 | Hub uzilganda overlay 120 s dan erta tushgan bo'lishi mumkin | 6-band | Ochiq: telefon soati bilan qayta o'lchash |

## Egasining talablari (sinov davomida)

- Bloklash paytida Ctrl+Alt+Del **umuman ishlamasligi** kerak (ekranning bo'sh bo'lishi yetarli emas).
- Bloklash paytida dastur ochib bo'lmasligi kerak.
- O'quvchi kompyuteridagi agent **SYSTEM darajasida** ishlashi va o'quvchi uni hech qanday yo'l bilan yopa olmasligi kerak.

Qarorlar: [ADR 0013](../../adr/0013-windows-hard-lock-results.md).
