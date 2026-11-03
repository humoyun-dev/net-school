# Windows x64 — qo'lda tekshiruv (2026-11-03)

Windows 11 (rus tili) · fizik noutbuk Lenovo LOQ 15IRX9 (`DESKTOP-NAF58T0`) · 1 monitor · Wi-Fi, keyin Ethernet · hub: Mac'da compose (`https://10.10.0.189`)

| # | Band | Natija | Izoh |
|---|---|---|---|
| 1 | Xabar | ha | "Сообщение от учителя" oynasi markazda, matn va OK; buyruq 1,25 s da tasdiqlandi (2026-11-02, miniatura bilan). Matnlar Windows tilida (rus). |
| 2 | Bloklash/ochish | ha | Overlay butun ekranni va taskbar'ni qoplaydi, o'qituvchi matni ko'rinadi; ochishdan keyin ≤1,5 s ichida yo'qoladi. **Qochish testi (bloklangan holda, kompyuterning o'z klaviaturasi):** Alt+Tab va Win+D overlay'dan o'tmadi; **Win (Start), Ctrl+Shift+Esc (Vazifalar menejeri) va Ctrl+Alt+Del ishladi** — soft overlay ularni to'smaydi. Xavfli: egasi bu kombinatsiyalar umuman ishlamasligi kerak deb talab qildi. |
| 3 | Lease tugashi | ha | Bloklash yoqiq, hub `api` 10:08:46 da to'xtatildi; foydalanuvchi overlay tushganini 10:10:54 da xabar qildi (≈120 s + javob vaqti). `api` qayta yoqilgach o'qituvchining faol bloklashi qaytdi — kutilgan. |
| 4 | Reboot | qisman | Bloklash yoqiq holda markaziy reboot: kirishdan keyin bloklash **qaytdi** — o'qituvchi bloklashi bekor qilinmagani uchun hub uni qayta qo'llaydi (to'g'ri). Kamchilik: qayta qo'llanganda o'qituvchi matni yo'qoladi (faqat sarlavha). "Eskirgan" holat (kompyuter o'chiq paytida bloklash bekor qilinadi) alohida sinalmagan. |
| 5 | Yordam | ha | Tray holat oynasidagi "Помощь": panel plitkasida to'q sariq halqa va ✋ chiqdi; o'qituvchi "Yopish" bilan olib tashladi. |
| 6 | Miniatura | ha | Har ~2 s, kechikish ≤1 s; yangi dars boshlangach birinchi kadr ~7 s da. |
| 7 | Ko'rish | ha | Ekran ko'rinadi, sichqoncha ikki marta bosish hech narsa ochmadi (gateway `relay_input` ni tashladi). Ekran o'zi ulanadi (PR #14). |
| 8 | Boshqarish | ha | Sichqoncha ishlaydi (Korzina ochildi). Klaviatura: avval ishlamadi — MeshCentral canvas'i mousedown'da preventDefault qilib iframe fokus olmasdi; tuzatildi (ko'prik bosishda fokus oladi, panel ulanganda fokus beradi), keyin Windows qulf ekranida PIN va ish stolida matn panel orqali kiritildi. Ikkinchi boshqaruv haqiqiy sharoitda "Kompyuterni boshqa foydalanuvchi boshqaryapti" bilan rad etildi. Mac klaviaturasi: Cmd+harf avval Windows'ga faqat Win bo'lib borardi (macOS Cmd bilan keypress chiqarmaydi) — tuzatildi, Cmd+E Explorer'ni ochadi. Win+T/Win+L/Alt+Tab/Ctrl+Alt+Del va boshqalar "Maxsus tugmalar" menyusidan; to'liq ekran + Keyboard Lock rejimida Chrome kombinatsiyalari ham Windows'ga ketadi. |
| 9 | Revoke | ha | Boshqarish sessiyasi API orqali bekor qilindi (`DELETE /remote-sessions/{id}`): `control.ashx` va `meshrelay.ashx` 202 ms da yopildi (talab ≤10 s). Kamchilik: panel "Ulanish uzildi" + "Qayta ulanish" ko'rsatadi, "Sessiya yopildi" bo'lishi kerak. |
| 10 | UAC | ha | Boshqarish paytida "Запуск от имени администратора": UAC so'rovi (secure desktop) panelda ko'rindi, "Да" masofadan bosildi, administrator cmd ochildi (MeshAgent SYSTEM huquqida). Xavfsizlik nuqtasi: o'qituvchi masofadan UAC'ni tasdiqlay oladi — risks.md ga. |
| 11 | Ko'p monitor | yo'q | Bitta monitor. |
| 12 | Lock screen / foydalanuvchi almashtirish | qisman | Win+L: Companion onlayn qoladi (heartbeat har 10 s), miniatura qulf ekranini (soat, vidjetlar) ko'rsatadi; boshqarish oynasida qulf ekrani ko'rinadi va PIN kiritsa bo'ladi. Foydalanuvchi almashtirish sinalmagan. |

Qo'shimcha:

- **Autostart:** markaziy o'chirish va reboot'dan keyin Companion `start.cmd` siz o'zi ulandi (HKLM Run, PR #13).
- **Quvvat:** shutdown — yumshoq buyruqni Notepad (saqlanmagan matn) to'sdi, 60 s dan keyin majburiy bosqich bilan o'chdi (PR #15, `windows-x64-2026-11-03-shutdown.json`); reboot — bloklangan holda ~100 s, majburiysiz (`windows-x64-2026-11-03-reboot.json`).
- **Wake (WoL):** sinalmagan. Noutbuk iste'molchi modeli: BIOS va Realtek drayverida WoL sozlamasi topilmadi; hub o'zi sehrli paket yuborish ishi keyinga qoldirildi.
- **Panel miniaturasi:** hub 2 daqiqa to'xtaganda panel miniatura oqimi 5 urinishdan keyin butunlay to'xtardi (sahifa yangilanguncha "Rasm yo'q"); tuzatildi — sekin oraliqda urinishda davom etadi.
- **Bloklash matni:** reboot'dan keyin hub bloklashni qayta qo'llaganda o'qituvchi matni ko'rsatilmaydi (faqat sarlavha) — ochiq kamchilik.
