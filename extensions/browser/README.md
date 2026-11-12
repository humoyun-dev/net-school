# NetSchool brauzer extension'i (P2c)

Chrome va Edge uchun MV3 extension: maktab web siyosatini (`bazaviy` + `dars`) `declarativeNetRequest` qoidalari bilan qo'llaydi. Siyosatni Companion'dan native messaging host (`netschool-helper.exe`) orqali oladi; Helper uni HKLM siyosatlari bilan majburan o'rnatadi ([ADR 0015](../../docs/adr/0015-policy.md)).

```bash
pnpm build:extension                       # dist/ — unpacked (chrome://extensions → "Load unpacked") va do'kon uchun
pnpm vitest run --project unit extensions  # qoidalar va holat testlari
```

Do'konga chiqarish (unlisted) va ID'larni hub'ga yozish: [runbook A](../../docs/poc/results/windows-x64-2026-11-12-policy-manual.md). Imzolash kalitini do'kon saqlaydi — repoda kalit yo'q.
