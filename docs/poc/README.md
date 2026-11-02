# P0c — OS PoC

Maqsad: NetSchool zanjirini haqiqiy kompyuterlarda sinash va natijani dalil bilan [capability matrix](capability-matrix.md)ga yozish (spec §5.2, §7).

| Fayl | Nima |
|---|---|
| [runbook-windows.md](runbook-windows.md) | Windows sinovining qadamlari va qo'lda tekshiriladigan ro'yxat |
| [capability-matrix.md](capability-matrix.md) | Har OS va imkoniyat bo'yicha holat va dalil |
| [risks.md](risks.md) | Ma'lum xavflar va cheklovlar |
| `results/` | `verify` JSON natijalari va qo'lda tekshiruv yozuvlari (dalil) |

Asboblar:
- `scripts/poc/hubctl.mjs` — hub'ni API orqali boshqarish (xona, enrollment token, MeshCentral bog'lash, o'qituvchi, dars);
- `scripts/poc/verify.mjs` — avtomatik tekshiruv va JSON dalil;
- `scripts/poc/matrix.mjs` — matrix tekshiruvi (CI'da ham ishlaydi);
- `netschool-admin mesh-agent-installer` — bino uchun MeshAgent o'rnatuvchisi;
- `pnpm --filter @netschool/companion pack:win` — Windows uchun portable Companion.
