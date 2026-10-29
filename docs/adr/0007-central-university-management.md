# ADR 0007: Universitet miqyosidagi markaziy boshqaruv (majburiy)

Sana: 2026-10-29 · Holat: qabul qilingan · Kontekst: mahsulot egasi talabi · Bog'liq: [spec §7.1](../architecture/NETSCHOOL_ARCHITECTURE_v1.md), [yo'l xaritasi](../superpowers/plans/2026-10-27-netschool-roadmap.md)

## Talab (mahsulot egasidan)

NetSchool butun universitet uchun **markaziy** dastur: universitetning barcha kompyuterlari bitta markazlashgan tarmoq sifatida boshqariladi. Quyidagi imkoniyatlar **ixtiyoriy emas — har doim bo'lishi shart** va ularsiz mahsulot release qilinmaydi:

1. **Quvvat:** kompyuterlarni markazdan o'chirish, qayta yuklash, uxlatish va yoqish (Wake-on-LAN); bitta qurilma, xona, bino yoki butun universitet bo'yicha; jadval bilan.
2. **Dastur o'rnatish:** admin huquqi bilan markazdan dastur o'rnatish, yangilash va o'chirish (bitta qurilmadan butun universitetgacha).
3. **Majburiy cheklovlar:** foydalanuvchi (talaba) dastur o'rnata va o'chira olmaydi, oboi va desktop sozlamalarini o'zgartira olmaydi; cheklov buzilsa (qo'lda o'zgartirilsa) avtomatik qayta qo'llanadi.
4. **To'liq ma'muriy huquq:** markaziy IT admin barcha kompyuterlarda yuqoridagilarni va texnik boshqaruvni (remote desktop/control, terminal, fayllar) bajara oladi.

## Qarorlar

- **Model.** Universitet = bitta `organization`; bino/fakultet/kampus = `site`; auditoriya/laboratoriya = `room`. Butun universitet tarmog'i bitta **markaziy hub** (NetSchool API + MeshCentral + PostgreSQL) bilan boshqariladi. Bu P1a ma'lumot modeliga mos (tashkilot → site → xona); oldingi "har maktabga o'z hub'i" (P3c) modeli universitet uchun markaziy hub bilan almashtiriladi, bir nechta kampus/hub esa keyingi kengaytma.
- **Har kompyuterda majburiy komponentlar.** MeshAgent, NetSchool Companion va **NetSchool OS Helper** (SYSTEM/root xizmat) — uchalasi har boshqariladigan kompyuterga o'rnatiladi. Helper endi "kerak bo'lsa" emas, majburiy. macOS'da qat'iy cheklovlar Apple talabiga ko'ra faqat **MDM** orqali ishlaydi, shuning uchun macOS kompyuterlar MDM'ga (imkon bo'lsa Apple Business/School Manager orqali supervised) ro'yxatdan o'tkaziladi.
- **Rollar.** Butun universitet bo'yicha (org-wide) **markaziy IT admin** — barcha qurilma boshqaruvi huquqlari (quvvat, dastur, siyosat, remote control, terminal, fayllar) barcha site'larda. Site (bino) IT admini — xuddi shu huquqlar faqat o'z binosida. O'qituvchi bu huquqlarga ega emas (faqat o'z darsidagi dars buyruqlari, ADR 0006); talaba — hech qanday.
- **Kuch bilan birga himoya (huquqlarni cheklamaydi, nazorat qiladi).** Har amal auditda (kim, qachon, qaysi qurilmalar, natija). Dastur faqat markaziy katalogdagi imzolangan/checksum'li paketdan o'rnatiladi (ixtiyoriy faylni emas). Ommaviy xavfli amal (butun bino/universitet o'chirish, ommaviy o'chirib tashlash) qurilma sonini ko'rsatib tasdiq so'raydi va bosqichma-bosqich (rollout) bajariladi. Terminal sessiyalari faqat markaziy/site IT admin uchun va audit qilinadi. Bular admin huquqini kamaytirmaydi — xato yoki o'g'irlangan akkauntdan butun tarmoqni himoya qiladi.
- **Cheklovlar doim amalda.** Siyosat hub'da saqlanadi va Helper tomonidan qo'llanadi; Helper davriy tekshiradi va farq (drift) topilsa qayta qo'llaydi va auditga yozadi. Tarmoq uzilsa ham oxirgi maktab (universitet) bazaviy siyosati qurilmada qoladi (spec §10: bazaviy siyosat offline'da saqlanadi). Talaba admin emas, standart foydalanuvchi.
- **Natija har qurilma bo'yicha.** Quvvat, o'rnatish va siyosat buyruqlari P1c buyruq modeli (target bo'yicha holat, idempotency, outbox, audit) ustida; javobi yo'qolishi mumkin bo'lgan quvvat buyrug'i `unknown` va keyingi tekshiruv bilan (spec §9).

## Ma'lum fizik/OS cheklovlari (va'da qilinmaydi)

- Wake-on-LAN faqat BIOS/tarmoq kartasi qo'llasa va kompyuter tokka ulangan bo'lsa ishlaydi; o'sha tarmoq segmentidagi yoqiq agent signal beradi. Rozetkadan uzilgan kompyuterni yoqib bo'lmaydi.
- Kompyuterga jismoniy kirish bo'lsa (boshqa OS'dan yuklash, diskni olish) dasturiy cheklov chetlab o'tilishi mumkin: BIOS/UEFI paroli, yuklash tartibini qulflash va disk shifrlash tashkiliy majburiy chora sifatida o'rnatish yo'riqnomasiga kiradi.
- macOS'da MDM'siz qat'iy cheklov mumkin emas; Linux'da qo'llab-quvvatlanadigan desktop muhitlari (GNOME/KDE) P0c/P2 sinovi bilan aniqlanadi.

## Oqibatlar

- Yo'l xaritasiga majburiy sub-planlar qo'shildi: **P1h** (markaziy quvvat boshqaruvi), **P2g** (markaziy dastur o'rnatish), **P2h** (majburiy OS cheklovlari va drift nazorati); **P2d** (OS Helper) va **P2e** (installer) majburiy komponentlarga moslandi; **P3c** universitet markaziy hub modeliga o'zgardi.
- Release sharti: ushbu ADR'dagi 4 ta imkoniyat qo'llab-quvvatlanadigan har OS uchun sinovdan o'tmaguncha versiya chiqarilmaydi.
- Yuk: universitet miqyosi (yuzlab–minglab kompyuter) P2f yuk sinoviga qo'shiladi; aniq son pilotdan oldin belgilanadi.
