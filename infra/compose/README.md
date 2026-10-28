# School hub (Docker Compose, pilot)

Servislar: `postgres` (NetSchool va MeshCentral uchun **alohida** database va user), `meshcentral` (pin qilingan submodule'dan build), `api-migrate` (bir martalik migratsiya), `api` (NetSchool API, HTTPS).

Tashqariga faqat `api` chiqadi (`443 → 8443`). MeshCentral web/admin paneli va PostgreSQL hech qanday port publish qilmaydi (spec §13). MeshCentral agent porti P0c natijasiga ko'ra qo'shiladi — hozircha publish qilinmagan.

## Sirlar

`infra/compose/secrets/` (gitignored) ichida fayllar sifatida:

```bash
cd infra/compose
mkdir -p secrets && chmod 700 secrets
for s in postgres_superuser_password netschool_db_password meshcentral_db_password; do
  openssl rand -hex 32 | tr -d '\n' > "secrets/$s"   # hex: DB URL'da kodlash talab qilmaydi
done
printf 'postgres://netschool:%s@postgres:5432/netschool' "$(cat secrets/netschool_db_password)" > secrets/netschool_database_url
# TLS: maktab CA yoki admin tarqatgan lokal CA bilan imzolangan sertifikat (spec §13)
cp /path/to/hub.crt secrets/api_tls_cert
cp /path/to/hub.key secrets/api_tls_key
# Fayllar konteyner ichidagi postgres/node userlari o'qishi uchun 644; host'da himoya — papka 700.
chmod 644 secrets/*
cp .env.example .env   # PUBLIC_ORIGIN va MESHCENTRAL_CERT_NAME ni moslang
```

## Ishga tushirish

```bash
docker compose up -d --build
docker compose run --rm api-migrate node dist/cli.mjs bootstrap --org "Maktab" --site "Asosiy bino" --admin admin
# chiqqan bir martalik parol bilan https://<PUBLIC_ORIGIN> ga kiring va parolni almashtiring
```

Parolni tiklash (oflayn): `docker compose run --rm api-migrate node dist/cli.mjs reset-password <username>`.

## Cheklovlar (P1a)

- Remote-session gateway servisi P1d'da qo'shiladi.
- API'ning MeshCentral ulanishi (`MESHCENTRAL_URL`, `MESHCENTRAL_USERNAME`, `MESHCENTRAL_PASSWORD_FILE`, `MESHCENTRAL_CA_FILE`, `MESH_INSTANCE_ID`) va uning service account'i ham P1d'da; ungacha qurilmani MeshAgent'ga bog'lash 409 `capability_unavailable` qaytaradi (ADR 0005).
- MeshCentral `autoBackup` o'chiq: backup rejasi (NetSchool DB + MeshCentral DB + MeshCentral data/sertifikatlar) alohida vazifa (spec §13).
- `trustedProxy: 127.0.0.1` shablonda: gateway alohida konteynerda bo'lganda (P1d) uning tarmoq manzili bilan almashtiriladi.
