# ADR 0012: Windows PoC natijalari va release lock

Sana: 2026-11-03 · Holat: qabul qilingan · Kontekst: P0c · Reja: [p0c-windows-poc](../superpowers/plans/2026-11-02-p0c-windows-poc.md)

## Maqsad

Butun stekni haqiqiy Windows kompyuterida sinash: enrollment → inventar → xabar/bloklash/miniatura → ko'rish/boshqarish → revoke → quvvat. Natijalar `docs/poc/capability-matrix.md` ning Windows x64 ustunida, dalillar `docs/poc/results/` da.

## Sinov muhiti

- O'quvchi kompyuteri: Lenovo LOQ 15IRX9 (fizik noutbuk), Windows 11 (rus tili), avval Wi-Fi, keyin Ethernet.
- Hub: egasining Mac'ida docker compose (`compose.yaml` + `compose.poc.yaml`), `https://10.10.0.189`, agent porti 4433.
- Panel: Mac'dagi Chrome.
- Egasining talabi: sinovlar ish Mac'iga ta'sir qilmasin. Mac'ga agent yoki Companion o'rnatilmadi.

## Natijalar (qisqa)

| Soha | Natija |
|---|---|
| Enrollment, inventar, bog'lash | o'tdi (`verify` 8/8) |
| Xabar, yordam, miniatura (har ~2 s, ≤1 s kechikish) | o'tdi |
| Bloklash / ochish, lease (hub o'chsa ≈120 s da tushadi) | o'tdi; **qochish testi qisman** — Win, Ctrl+Shift+Esc, Ctrl+Alt+Del soft overlay'dan o'tadi |
| Ko'rish (kiritish to'siladi), boshqarish, `control_busy`, revoke (0,2 s) | o'tdi |
| UAC secure desktop | ko'rinadi va masofadan tasdiqlanadi (MeshAgent SYSTEM) |
| Quvvat: shutdown, reboot | o'tdi (shutdown — majburiy bosqich bilan) |
| Quvvat: sleep, wake | sinalmagan (WoL — noutbukda sozlama topilmadi) |
| Companion autostart | o'tdi (shutdown/reboot'dan keyin o'zi ulandi) |

## Sinovda topilgan va tuzatilgan muammolar

| Topilma | Tuzatish |
|---|---|
| API image panelni o'z ichiga olmasdi (compose'da 404) | Dockerfile `apps/web` ni yig'adi, `WEB_DIST_DIR`; compose-smoke tekshiradi (PR #12) |
| Windows'da masofaviy ekran ulanmasdi: MeshCentral 1.3.1 `msg/userSessions` ni gateway tashlardi | viewer-policy `userSessions` ga ruxsat beradi (faqat sessiya node'i) (PR #12) |
| MeshCentral'ning eski interfeysi, "Connect" qo'lda | Gateway ko'prigi: interfeys yashiriladi, ekran o'zi ulanadi, holat panelga (PR #14) |
| Companion qayta yoqilgach ishlamasdi | `enroll.cmd` HKLM Run (PR #13) |
| Yumshoq o'chirishni ochiq dastur to'sdi | 60 s dan keyin bir marta majburiy `runcommands` (PR #15) |
| Klaviatura masofaviy ekranga yetmasdi (iframe fokus olmasdi) | Ko'prik bosishda fokus oladi, panel ulanganda fokus beradi |
| Mac Cmd+harf Windows'ga faqat Win bo'lib borardi (macOS Cmd bilan keypress chiqarmaydi) | Ko'prik Cmd+harfni kod bilan yuboradi |
| Win, Win+L, Alt+Tab, taskbar Mac'dan yetib bo'lmasdi | "Maxsus tugmalar" menyusi (qat'iy ro'yxat) va to'liq ekran + Keyboard Lock |
| Hub 2 daqiqa o'chganda panel miniaturasi butunlay to'xtardi | Tez urinishlardan keyin 60 s oraliqda davom etadi |

## Qarorlar

1. **Windows x64 — pilot uchun asosiy platforma.** Matrix'dagi `passed` bandlar shu ADR'dagi muhitda tasdiqlangan. Windows ARM64, macOS va Linux `not_tested`: mashina paydo bo'lmaguncha ular uchun da'vo yo'q (ADR 0007).
2. **Soft overlay pilot uchun yetarli emas.** Egasi: Win, Vazifalar menejeri va Ctrl+Alt+Del bloklash paytida umuman ishlamasligi kerak. Laboratoriyalarda Windows 10/11 **Pro va Home**, shuning uchun Keyboard Filter yo'q. Yo'l: Companion'da low-level keyboard hook (Win, Alt+Tab, Ctrl+Esc, Ctrl+Shift+Esc, Alt+F4) va OS helper (SYSTEM, P2d'ning birinchi qismi) bloklash vaqtida o'quvchi profiliga siyosatlar qo'yadi (DisableTaskMgr; Ctrl+Alt+Del ekranidan qulflash, almashtirish, chiqish, parol, quvvat olib tashlanadi), bloklash tugashi bilan qaytaradi. Alohida reja.
3. **Wake-on-LAN hub'dan ham yuboriladi** (egasining talabi), faqat yoqiq agentga tayanilmaydi. Keyinga qoldirildi; laboratoriya stol kompyuterlarida BIOS WoL va Fast Startup sozlamalari runbook'ga.
4. **Mac'dan boshqarish:** Cmd = Win (MeshCentral odati), Control = Ctrl, Option = Alt. Brauzer ushlaydigan kombinatsiyalar menyudan yoki to'liq ekranda.
5. **Release lock:** `upstream.lock.json` — MeshCentral commit `adce1ec4` (1.3.1), agent manifest (sha384), sinovda ishlatilgan lokal image `sha256:773d2d72…` (registry yo'q; pilotda registry digest bilan almashtiriladi).

## Ochiq qolganlar

- Kuchli bloklash (yuqoridagi 2-qaror).
- Hub'dan WoL; sleep sinovi; ko'p monitor; foydalanuvchi almashtirish.
- Reboot'dan keyin qayta qo'llangan bloklashda o'qituvchi matni yo'qoladi.
- Revoke'dan keyin panel "Sessiya yopildi" o'rniga "Qayta ulanish"ni taklif qiladi.
- Windows ARM64, macOS, Linux X11/Wayland sinovlari.
