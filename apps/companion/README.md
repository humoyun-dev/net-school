# NetSchool Companion

O'quvchi kompyuteridagi ilova (Electron): hub bilan aloqa, o'qituvchi xabarlari, yumshoq overlay, yordam so'rovi va dars davomida ekran miniaturasi. Qarorlar: [ADR 0009](../../docs/adr/0009-companion.md).

## Yig'ish va ishga tushirish (dev)

```bash
pnpm install
node apps/companion/node_modules/electron/install.js   # Electron binary (bir marta)
pnpm --filter @netschool/companion build               # dist/main.cjs, preload.cjs, renderer/, enroll.mjs
```

## Windows uchun portable paket (P0c, installer'siz)

```bash
pnpm build:helper                                          # native/helper/dist/netschool-helper-windows-*.exe
pnpm --filter @netschool/companion pack:win --arch x64     # yoki arm64 (Apple Silicon'dagi Windows VM)
# → apps/companion/out/netschool-companion-win32-<arch>.zip
```

Zip tarkibi:
- Electron 45.2.1 (`@electron/get`, SHASUMS bilan tekshiriladi);
- `NetSchool Companion.exe`;
- oddiy (test emas) build `resources/app/` ichida;
- `netschool-helper.exe` (arch'ga mos OS helper; yo'q bo'lsa paket yig'ilmaydi);
- `enroll.cmd`: ro'yxatdan o'tkazadi (Electron'ni Node sifatida ishlatadi), keyin
  `netschool-helper.exe install` — helper SYSTEM xizmati sifatida `%ProgramFiles%\NetSchool\` ga o'rnatiladi va
  Companion'ni har kirishda o'zi ishga tushiradi (HKLM Run autostart endi yo'q, install eskisini o'chiradi);
- `install.cmd` (yangilash, qayta ro'yxatdan o'tkazmasdan), `uninstall.cmd` (xizmat, fayllar, siyosatlar) va `start.cmd`.
  `.cmd` fayllar faqat yoyilgan paket katalogidan ishga tushiriladi (Program Files'ga nusxalanmaydi).

Helper kaliti va hub sozlamalari faqat `%ProgramData%\NetSchool\helper\` da (faqat SYSTEM/Administrators):
Windows'da `enroll` ularni paket yonidagi `netschool-helper.exe helper-key` (claim'dan oldin) va `set-hub`
(claim'dan keyin) orqali yozdiradi, o'zi kalitni ko'rmaydi.

Test build'ni paketlash rad etiladi. P2d1'dan oldin ro'yxatdan o'tgan kompyuterda helper kaliti yo'q: yangi token
bilan `enroll.cmd ... --force` ishga tushiriladi.

## Ro'yxatdan o'tkazish (IT admin, har kompyuterda bir marta)

1. Hub'da enrollment token yarating (`POST /api/v1/enrollments`, site admin yoki IT).
2. Kompyuterda admin huquqi bilan:

```bash
NETSCHOOL_ENROLL_TOKEN=nse_... node apps/companion/dist/enroll.mjs \
  --hub https://hub.school.lan --ca /path/to/hub-ca.pem
```

`--ca` hub sertifikatining CA'si (o'z-o'zidan imzolangan yoki maktab CA'si). Berilmasa tizim root'lariga ishoniladi. Token buyruq tarixida qolmasligi uchun `--token` o'rniga `NETSCHOOL_ENROLL_TOKEN` tavsiya etiladi. Qayta ro'yxatdan o'tkazish — `--force`.

Chiqish kodlari: `0` muvaffaqiyat, `2` noto'g'ri argument yoki mashina katalogiga yozish huquqi yo'q (admin sifatida ishga tushiring), `3` hub'ga ulanib bo'lmadi yoki sertifikat ishonchsiz, `4` hub rad etdi (token ishlatilgan/noto'g'ri) yoki kompyuter allaqachon ro'yxatdan o'tgan.

## Kataloglar

| Nima | Joy |
|---|---|
| Mashina (kalit, `device.json`, `hub-ca.pem`) | Windows `%ProgramData%\NetSchool\companion`, macOS `/Library/Application Support/NetSchool/companion`, Linux `/var/lib/netschool/companion` |
| Foydalanuvchi holati (`state.sqlite`) | Electron `userData` |

Muhit o'zgaruvchilari (dev/sinov): `NETSCHOOL_COMPANION_DIR` (mashina katalogi), `NETSCHOOL_COMPANION_STATE_DIR` (holat), `NETSCHOOL_COMPANION_LOCALE` (`uz`/`ru`/`en`), `NETSCHOOL_COMPANION_SHOW_STATUS=1` (holat oynasini ochiq boshlash).

## Sinovlar

```bash
pnpm test                                   # unit + real hub'ga qarshi integratsiya (Electron'siz)
pnpm test:e2e:companion   # test build yig'adi va haqiqiy Electron'ni oynalar yashirin holda ishga tushiradi
```

E2e oynalarni ekranda ko'rsatmaydi va ishchi ekranni qoplamaydi. Yashirin rejim faqat test build'ida bor (`NETSCHOOL_COMPANION_TEST_BUILD=1`); oddiy build'da bu kod yo'q, shuning uchun o'quvchi uni yoqa olmaydi. Test build'ni o'quvchi kompyuteriga o'rnatmang. CI'da `companion-e2e` ishi xvfb ostida, Chromium sandbox yoqilgan holda ishlaydi.

## Muammolarni aniqlash

- **"Xavfsiz ulanish tekshiruvidan o'tmadi"** — hub sertifikati `hub-ca.pem` (yoki tizim root'lari) bilan tasdiqlanmadi, yoki sertifikat boshqa nom uchun chiqarilgan. `--hub` manzili sertifikatdagi nomga mos bo'lishi kerak. Kompyuter soati juda noto'g'ri bo'lsa ham sertifikat "hali kuchga kirmagan/muddati o'tgan" bo'lib ko'rinadi — soatni to'g'rilang.
- **"Qurilma hub tomonidan rad etildi"** — qurilma hub'da retire qilingan yoki kalit mos emas: qayta `enroll --force`.
- **Miniatura "tizim ruxsati kerak"** (macOS) — System Settings → Privacy & Security → Screen Recording'da NetSchool'ga ruxsat bering; Companion 30 s ichida o'zi yangilanadi.
