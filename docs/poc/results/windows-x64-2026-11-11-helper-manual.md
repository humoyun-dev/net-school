# Windows x64 — NetSchool Helper qo'lda qabul sinovi (P2d1 Task 12, runbook)

**Natija: hali o'tkazilmagan.** Bu fayl qabul sinovining tartibi va bo'sh natija jadvali. Sinovni egasi Windows x64 kompyuterida o'tkazadi va har qatorni to'ldiradi. To'ldirilmaguncha matrix'da hech narsa `passed` deb belgilanmaydi ([ADR 0014](../../adr/0014-windows-helper.md), 9-band).

Sana: — · Kompyuter: — · Windows nashri va versiyasi (`winver`, Education/Pro/Home): — · Hub: — · Paket: Companion `pack-win` zip + `netschool-helper.exe` (commit: —)

## Shartlar

- Sinov **standart (admin emas) o'quvchi hisobida** o'tkaziladi (risk #17). Admin amallari (o'rnatish, majburan o'ldirish, `uninstall`) alohida admin hisobidan yoki "Запуск от имени администратора" bilan; har qatorda kim bajargani yoziladi.
- Paket katalogi o'quvchi yoza olmaydigan joyda bo'lsin (masalan, admin yaratgan `C:\Users\<admin>\Downloads\netschool`); `uninstall.cmd` shu katalogdan ishga tushiriladi.
- Vaqt o'lchovlari telefon soati bilan (laptop soati hub'dan farq qilishi mumkin, 2026-11-09 natijasi).
- Bloklash panelda `overlay.lock` bilan yuboriladi. Har bandda panel ko'rsatgan `classroom.overlay` darajasi va sababi, `classroom.sas_block` holati yoziladi.
- Holat tekshiruvlari (admin cmd): `sc query NetSchoolHelper`, `sc qc NetSchoolHelper`, `sc sdshow NetSchoolHelper`, `sc qfailure NetSchoolHelper`, `icacls`, `reg query`, Event Viewer → Application → manba `NetSchoolHelper`.

## Tayyorgarlik (bajarilsa ✓)

1. Hub'da enrollment token yaratish (site admin yoki IT).
2. **Ishonchsiz katalog sinovi uchun:** o'rnatishdan oldin o'quvchi hisobida `mkdir %ProgramData%\NetSchool` va ichiga istalgan fayl (o'quvchi egasi bo'lgan katalog). 11-qatorda tekshiriladi.
3. O'quvchi hisobida bloklashdan oldin ochib qo'yiladi: brauzer (2–3 tab), `cmd.exe`, Vazifalar menejeri (`System32\taskmgr.exe`).

## Natijalar

Holat ustuni: `pending` | `ha` | `yo'q` | `qisman`. Hozir hammasi `pending`.

| # | Band | Kutilgan natija | Holat | Izoh / dalil |
|---|---|---|---|---|
| 1 | O'rnatish: admin `enroll.cmd --hub https://<hub> --ca <hub-ca.pem>` (token `NETSCHOOL_ENROLL_TOKEN` orqali) | enroll helper kalitini `netschool-helper helper-key` bilan yaratadi (token stdin orqali), claim'dan keyin `set-hub` (CA stdin orqali), so'ng `install`; chiqish kodi 0; panelda qurilma va `classroom.overlay`, `classroom.sas_block` ko'rinadi | pending | |
| 2 | Xizmat parametrlari: `sc qc`, `sc qfailure`, `sc sdshow NetSchoolHelper` | `NetSchoolHelper`, `NetSchool Helper`, `AUTO_START`, `LocalSystem`; recovery 1 s / 1 s / 5 s, reset 86400; SDDL ADR 0014'dagi bilan aynan | pending | |
| 3 | Katalog ACL'i: `icacls "%ProgramData%\NetSchool\helper"` va `icacls "%ProgramFiles%\NetSchool"` | helper katalogi: faqat `NT AUTHORITY\SYSTEM` va `BUILTIN\Administrators` (meros yo'q, Users o'qiy olmaydi); `%ProgramFiles%\NetSchool`: Users faqat o'qish/bajarish (`RX`), yozish faqat SYSTEM/Administrators | pending | |
| 4 | O'quvchi `sc stop NetSchoolHelper` | «Отказано в доступе» (5); xizmat ishlayveradi | pending | |
| 5 | O'quvchi Vazifalar menejerida `netschool-helper.exe` (xizmat va guard) ni yopishga urinadi | «Отказано в доступе»; ikkalasi ham yashaydi | pending | |
| 6 | O'quvchi Companion'ni Vazifalar menejeridan yopadi (bloklashsiz) | ≤ 3 s da qaytadi (telefon soati) | pending | |
| 7 | O'quvchi `HKCU\Software\Microsoft\Windows\CurrentVersion\Policies` ga yozishga urinadi (`reg add ...\Policies\System /v DisableTaskMgr /t REG_SZ /d x`) | rad etiladi. Agar yozilsa — topilma: REG_SZ qiymat siyosat `Apply`ni yiqitadi (`policy_failed`) | pending | |
| 8 | Bloklash: panel darajasi | `classroom.overlay`: `hard`; Education/Enterprise'da `classroom.sas_block`: `available`, Pro/Home'da `unsupported` (`edition`) | pending | |
| 9 | Bloklashda o'quvchi klaviaturasi: Win, Alt+Tab, Ctrl+Esc, Ctrl+Shift+Esc, Alt+F4, Alt+Space (ko'p marta ketma-ket) | hammasi to'siladi | pending | |
| 10 | Bloklashda Ctrl+Alt+Del ekrani (Pro/Home) | ekran ochiladi, lekin Vazifalar menejeri, Qulflash, Chiqish, Parolni o'zgartirish, foydalanuvchini almashtirish, quvvat tugmasi yo'q; faqat «Отмена» | pending | |
| 11 | Ishonchsiz katalog (tayyorgarlik 2) | install o'quvchi yaratgan `%ProgramData%\NetSchool` ni o'chirib qayta yaratdi; helper katalogi tekshiruvdan o'tdi (jurnalda xato yo'q, panelda helper holati keladi) | pending | |
| 12 | Bloklashda o'quvchi jarayonidan `SendInput(Win)` (medium IL, masalan, PowerShell skripti yoki AutoHotkey) | to'siladi (`LLKHF_LOWER_IL_INJECTED`) | pending | |
| 13 | Bloklashda o'qituvchining masofaviy boshqaruvi (MeshAgent): sichqoncha, matn, Win tugmasi | ishlaydi (injected, lekin LOWER_IL emas) | pending | |
| 14 | Process guard: bloklashdan oldin ochilgan brauzer va tablari | yashaydi; brauzerda yangi tab ochiladi | pending | |
| 15 | Process guard: oldin ochilgan `cmd` dan `notepad` | notepad ≤ 1 s da o'ldiriladi; cmd yashaydi | pending | |
| 16 | Process guard: oldin ochilgan Vazifalar menejeri | bloklash boshlanishi bilan yopiladi | pending | |
| 17 | Process guard: yangi dastur (Win+R yo'q, shuning uchun brauzerdan yuklangan `.exe` yoki ish stolidagi yorliq) | ochilmaydi (o'ldiriladi) | pending | |
| 18 | Process guard: qaysi shell/UWP jarayonlari o'ldirildi (RuntimeBroker, SearchHost, TextInputHost, StartMenuExperienceHost, dllhost, boshqalar) | ro'yxat yoziladi (Event Viewer / Process Explorer); kerak bo'lsa ruxsat ro'yxati keyin kengaytiriladi | pending | |
| 19 | Ochish | hammasi qaytadi: tugmalar, Ctrl+Alt+Del bandlari, siyosatlar (`reg query HKU\<SID>\...\Policies`), explorer (o'ldirilgan bo'lsa qayta ishga tushirilgan), yangi dasturlar ochiladi; panel `soft` + `lock_inactive` | pending | |
| 20 | Bloklangan holda hub to'xtatiladi (`docker compose stop api`) | ~120 s da hammasi qaytadi (telefon soati bilan vaqt, lease); hub qaytgach bloklash qayta qo'llanadi | pending | |
| 21 | Bloklangan holda admin helper xizmatini majburan o'ldiradi (`taskkill /f /pid <xizmat PID>`) | xizmat 1 s da qaytadi; bloklash shu boot ichida tiklanadi (`lock.json`), siyosat to'g'ri (ortiqcha yoki yo'qolgan qiymat yo'q) | pending | |
| 22 | Bloklangan holda reboot | boot'dan keyin saqlangan bloklash **tiklanmaydi** (boot ID boshqa); hub hali bloklangan bo'lsa, hub so'rovidan keyin qayta qo'llanadi; Companion va guard o'quvchi kirgach ishga tushadi | pending | |
| 23 | Admin `sc stop "Mesh Agent"` | ≤ 15 s da qayta ishga tushadi; panel helper holatida `meshAgent: restarted` | pending | |
| 24 | `CreateProcessAsUser` xatosi | Companion yoki guard 1314 (`ERROR_PRIVILEGE_NOT_HELD`) bilan ishga tushmasa — yoziladi (`SeAssignPrimaryTokenPrivilege`/`SeIncreaseQuotaPrivilege` yoqish kerak) | pending | |
| 25 | Keyboard Filter (faqat Education/Enterprise): bloklashda Ctrl+Alt+Del va Win+L | ikkalasi umuman ishlamaydi; ochishda qaytadi | pending | |
| 26 | Keyboard Filter: bloklangan holda kompyuterni tok/tugma bilan majburan o'chirish, keyin yoqish | boot'dan keyin filtr tozalangan (Ctrl+Alt+Del ishlaydi), `cad-journal.json` bo'yicha | pending | |
| 27 | `uninstall.cmd` (admin, paket katalogidan) | xizmat, Event Log manbasi, `%ProgramFiles%\NetSchool`, `%ProgramData%\NetSchool\helper` yo'q; siyosatlar va CAD filtri qaytarilgan; Companion autostart yo'q | pending | |

## Sinovda topilgan muammolar

| # | Topilma | Dalil | Holat |
|---|---|---|---|
| — | — | — | — |

## Xulosa

Hali o'tkazilmagan. Sinovdan keyin: natija bu faylga yoziladi, [capability matrix](../capability-matrix.md) (`classroom.overlay`, `classroom.sas_block`) va [risklar](../risks.md) (#4, #12, #16, #17) yangilanadi, [ADR 0014](../../adr/0014-windows-helper.md) "Ochiq qolganlar" bo'limi to'ldiriladi.
