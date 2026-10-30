# School hub (Docker Compose, pilot)

Servislar: `postgres` (NetSchool va MeshCentral uchun **alohida** database va user), `meshcentral` (pin qilingan submodule'dan build), `api-migrate` (bir martalik migratsiya), `api` (NetSchool API, HTTPS).

Tashqariga faqat `api` chiqadi: `443 → 8443` (API) va `8444 → 8444` (remote session gateway, ADR 0003). MeshCentral web/admin paneli va PostgreSQL hech qanday port publish qilmaydi (spec §13). MeshCentral agent porti P0c natijasiga ko'ra qo'shiladi — hozircha publish qilinmagan.

## API ↔ MeshCentral

- API `wss://meshcentral:4430/control.ashx` ga `netschool-svc` service account bilan ulanadi. Account'ni `meshcentral` konteyneri ([entrypoint.sh](../meshcentral/entrypoint.sh)) birinchi ishga tushishda `secrets/meshcentral_service_password` bilan yaratadi va site administrator qiladi; keyingi ishga tushishlarda mavjud account'ga tegilmaydi (parol ham o'zgarmaydi).
- TLS: MeshCentral root CA'sining faqat public qismi (`root-cert-public.crt`) `meshcentral-ca` volume orqali api'ga read-only beriladi; `meshcentral-data` (private key'lar) api'ga mount qilinmaydi. Sertifikat nomi `meshcentral` ga qotirilgan — API hostname tekshiruvini o'chirmaydi.
- `api` faqat `meshcentral` healthy bo'lgach (CA fayli bor va 4430 shu CA bilan TLS javob beradi) ishga tushadi. Keyin MeshCentral uzilsa, API ishlashda davom etadi va fonda qayta ulanadi.
- `GET /api/v1/healthz` → `{"status":"ok","db":"ok","mesh":"ok"}`; `mesh`: `ok` (ulangan) | `down` (ulanmagan — HTTP baribir 200) | `disabled` (`MESHCENTRAL_URL` berilmagan).
- Barcha servislar `hub` tarmog'ida, qat'iy subnet bilan (`HUB_SUBNET`, standart `172.31.250.0/24`; boshqa konteynerlar `HUB_DYNAMIC_RANGE`, standart `172.31.250.128/25` dan oladi). `api` qat'iy manzilda (`API_IP`, standart `172.31.250.10`) va MeshCentral `trustedProxy` aynan shu IP (`MESHCENTRAL_TRUSTED_PROXY` → `render-config.mjs`): X-Forwarded-For faqat gateway'dan ishoniladi. DNS nomi ishlatilmaydi — MeshCentral uni faqat ishga tushishda aniqlaydi, `api` esa undan keyin ko'tariladi. Maktab LAN'i bilan to'qnashsa uchala qiymatni `.env`da birga almashtiring.

## Sirlar

`infra/compose/secrets/` (gitignored) ichida fayllar sifatida:

```bash
cd infra/compose
mkdir -p secrets && chmod 700 secrets
for s in postgres_superuser_password netschool_db_password meshcentral_db_password; do
  openssl rand -hex 32 | tr -d '\n' > "secrets/$s"   # hex: DB URL'da kodlash talab qilmaydi
done
printf 'postgres://netschool:%s@postgres:5432/netschool' "$(cat secrets/netschool_db_password)" > secrets/netschool_database_url
# MeshCentral service account paroli: passwordRequirements (min 16, har sinfdan 1) uchun `-Aa1` qo'shimchasi.
printf '%s-Aa1' "$(openssl rand -hex 24)" > secrets/meshcentral_service_password
# TLS: maktab CA yoki admin tarqatgan lokal CA bilan imzolangan sertifikat (spec §13)
cp /path/to/hub.crt secrets/api_tls_cert
cp /path/to/hub.key secrets/api_tls_key
# Fayllar konteyner ichidagi postgres/node userlari o'qishi uchun 644; host'da himoya — papka 700.
chmod 644 secrets/*
cp .env.example .env   # PUBLIC_ORIGIN va GATEWAY_PUBLIC_ORIGIN ni moslang
```

## Ishga tushirish

```bash
docker compose up -d --build
docker compose run --rm api-migrate node dist/cli.mjs bootstrap --org "Maktab" --site "Asosiy bino" --admin admin
# chiqqan bir martalik parol bilan https://<PUBLIC_ORIGIN> ga kiring va parolni almashtiring
```

Parolni tiklash (oflayn): `docker compose run --rm api-migrate node dist/cli.mjs reset-password <username>`.

## Cheklovlar

- MeshCentral `autoBackup` o'chiq: backup rejasi (NetSchool DB + MeshCentral DB + MeshCentral data/sertifikatlar) alohida vazifa (spec §13).
- `secrets/meshcentral_service_password` ni almashtirish mavjud account parolini o'zgartirmaydi: avval MeshCentral'da (`--resetaccount netschool-svc --pass=…`, server to'xtagan holatda) yangilang, keyin faylni.
