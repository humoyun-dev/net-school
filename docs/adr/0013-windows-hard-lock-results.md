# ADR 0013: Windows kuchli bloklash — sinov natijalari va SYSTEM helper'ga o'tish

Sana: 2026-11-09 · Holat: qabul qilingan · Kontekst: P2d0 · Reja: [p2d0-hard-lock](../superpowers/plans/2026-11-05-p2d0-hard-lock.md) · Dalil: [qo'lda sinov](../poc/results/windows-x64-2026-11-09-hard-lock-manual.md)

## Kontekst

P2d0 Companion ichida (o'quvchi huquqida) kuchli bloklashni qurdi: low-level klaviatura hook'i (koffi) va `HKCU\...\Policies` siyosatlari (Vazifalar menejeri, Win+L, Ctrl+Alt+Del ekranidagi bandlar). ADR 0012 bo'yicha laboratoriyalarda Windows 10/11 Pro va Home, ya'ni Keyboard Filter yo'q. Sinov ([natija](../poc/results/windows-x64-2026-11-09-hard-lock-manual.md)) quyidagilarni ko'rsatdi:

- Hook Electron asosiy oqimida bo'lsa, Windows uni olib tashlaydi (`LowLevelHooksTimeout`): birinchi bosish to'silib, keyingilari o'tadi.
- `HKCU\...\Policies` ga faqat administrator yoki SYSTEM yoza oladi. Companion siyosatni umuman qo'llay olmaydi (rejadagi "admin kerak emas" taxmini noto'g'ri edi).
- Ctrl+Alt+Del (SAS) foydalanuvchi rejimidagi hech qanday hook bilan to'silmaydi. O'quvchi Vazifalar menejeri orqali Companion'ni yopdi va bloklash paytida dastur ishga tushirdi.

## Qarorlar

1. **Hook alohida oqimda.** Hook `worker_threads` oqimida yashaydi. U oqim faqat `GetMessageW` siklida turadi va toza `KeyPolicy`ni chaqiradi, asosiy oqim bandligi unga ta'sir qilmaydi. Oqim to'xtatish `PostThreadMessageW(WM_QUIT)` bilan. Oqim kutilmaganda o'lsa, `hook_failed` (panel "kuchli" demaydi). Sinovda Win, Ctrl+Esc, Alt+Tab, Alt+F4, Alt+Space, Ctrl+Shift+Esc takroriy bosishda ham to'sildi. Go helper (P2d) bu vazifani olgunga qadar shu yo'l.
2. **Siyosat va Ctrl+Alt+Del — SYSTEM helper (P2d) ishi.** Companion siyosatni qo'llashga urinishda davom etadi va halol `soft` + `policy_failed` deb xabar beradi. Lekin haqiqiy qo'llash faqat SYSTEM xizmatidan bo'ladi.
3. **Egasining talablari P2d doirasiga kiradi:**
   - bloklash paytida Ctrl+Alt+Del **umuman ishlamasin** (faqat «Отмена» qolgan ekran yetarli emas);
   - bloklash paytida dastur ishga tushirib bo'lmasin;
   - o'quvchi kompyuteridagi agent SYSTEM darajasida ishlasin va o'quvchi uni yopa olmasin. Helper xizmati Companion'ni o'quvchi sessiyasida SYSTEM tokeni bilan ishga tushiradi va o'ldirilsa qayta ishga tushiradi.
4. **Standart o'quvchi hisobi — majburiy shart (P2h).** Administrator huquqli hisobda hech bir dastur "yopib bo'lmaydigan" emas: admin xizmatni to'xtata, fayllarni va siyosatni o'zgartira oladi. Sinov kompyuterining hisobi admin edi. Pilot va P2d qabul sinovlari standart o'quvchi hisobida o'tkaziladi.

## Ochiq qolganlar

- **Pro/Home'da Ctrl+Alt+Del'ni to'liq to'sish yo'li tanlanmagan.** Keyboard Filter faqat Education, Enterprise va IoT Enterprise nashrlarida. Variantlar: (a) laboratoriyalarni Windows Education'ga o'tkazish (akademik litsenziya); (b) Microsoft imzolagan kernel klaviatura filtr drayveri (EV sertifikat, attestatsiya imzosi). Qaror P2d rejasida, egasi bilan.
- `facts()` bloklash urinishi bo'lmasa ham `enforced: true` qaytaradi (bo'sh holatda va qayta ishga tushganda capability "hard"). Holat oxirgi haqiqiy urinishdan olinishi kerak.
- Reboot'dan keyin qayta qo'llangan bloklashda o'qituvchi matni yo'q (risk #15).
- Hub uzilganda overlay tushish vaqtini qayta o'lchash (120 s dan erta tushgan bo'lishi mumkin).
- MeshAgent xizmati bir marta o'z-o'zidan to'xtadi (sababi aniqlanmadi). Helper MeshAgent'ni ham kuzatishi kerak.
