# NetSchool veb-paneli

O'qituvchi va IT admin uchun brauzer paneli (React + Vite). Qarorlar: [ADR 0011](../../docs/adr/0011-web-panel.md).

## Build va production

```bash
pnpm --filter @netschool/web build      # apps/web/dist
```

API panelni o'z origin'idan beradi: `WEB_DIST_DIR=/path/to/apps/web/dist`. Cookie `__Host-` va `SameSite=Strict`, Origin tekshiruvi `PUBLIC_ORIGIN`ga aynan teng, CORS yo'q. Shuning uchun panelni boshqa domen yoki portdan berib bo'lmaydi.

## Dev

API'ni odatdagidek HTTPS bilan ishga tushiring, keyin:

```bash
NETSCHOOL_DEV_API=https://localhost:8443 \
NETSCHOOL_DEV_API_CA=/path/to/api-ca.pem \
NETSCHOOL_DEV_TLS_CERT=/path/to/cert.pem NETSCHOOL_DEV_TLS_KEY=/path/to/key.pem \
pnpm --filter @netschool/web dev
```

Vite `/api` so'rovlarini (WS ham) API'ga proxy qiladi va `Origin` headerini API manziliga almashtiradi. Bu faqat dev uchun; production'da panel API'ning o'zidan beriladi. Dev rejimida remote viewer iframe'i ishlamaydi: gateway `frame-ancestors`ga faqat `PUBLIC_ORIGIN`ni yozadi.

## Sinovlar

```bash
pnpm test               # unit (jsdom, soxta API)
pnpm test:e2e:web       # build + real API + headless Chromium (ekranga hech narsa chiqmaydi)
```
