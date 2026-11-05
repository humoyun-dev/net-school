# T1 spike: klaviatura hook Electron 45 ichida

Maqsad ([P2d0 reja](../../../superpowers/plans/2026-11-05-p2d0-hard-lock.md) T1): `koffi` bilan `WH_KEYBOARD_LL` Electron main jarayonida ishlaydimi.

## Ishga tushirish (Windows)
```
cd docs\poc\spikes\keyboard-hook
npm install
npm start
```
45 soniya davomida hook faol, keyin o'zi olib tashlanadi (xavfsizlik). Bu vaqtda:

| Tugma | Kutilgan |
|---|---|
| Win, Alt+Tab, Ctrl+Esc, Ctrl+Shift+Esc, Alt+F4, Alt+Space | to'siladi |
| Oddiy harflar, Ctrl+C, Shift+harf | o'tadi |
| Ctrl+Alt+Del, Win+L | hook to'smaydi (siyosat kerak) |

Natija `spike-result.json` ga yoziladi (o'rnatildimi, to'silgan tugmalar, eng sekin callback ms). Shu faylni yuboring.
