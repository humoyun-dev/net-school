# MeshCentral (upstream)

`upstream/` — `Ylianst/MeshCentral` git submodule. Pin: [upstream.lock.json](upstream.lock.json) bilan bir xil commit bo'lishi shart.

## Lokal ishga tushirish

```bash
git submodule update --init
cd infra/meshcentral/upstream
npm install
node meshcentral --datapath ../../../meshcentral-data --port 8443 --redirport 8080
```

`meshcentral-data/` sertifikat va kalitlarni saqlaydi, u `.gitignore` da. Commit qilmang.

## Config shabloni

[config.template.json](config.template.json) — qattiqlashtirilgan asos. Contract harness uni o'qiydi va faqat muhitga xos `settings.{cert, port, redirPort, exactPorts, selfUpdate, lanOnly, autoBackup, filesPath}` ni ustiga yozadi; production `config.json` ham shundan boshlanadi.

| Sozlama | Qiymat | Sabab |
| --- | --- | --- |
| `trustedProxy` | `127.0.0.1` (compose'da `api` IP'si) | Gateway oldinda turadi: X-Forwarded-For faqat shu manbadan ishoniladi, TLS saqlanadi (webserver.js:7353-7372). Compose'da gateway `api` konteynerida — `render-config.mjs` `MESHCENTRAL_TRUSTED_PROXY` dagi qat'iy IP'ni yozadi. DNS nomi emas: MeshCentral nomni faqat ishga tushishda aniqlaydi (webserver.js:7216-7217), `api` esa undan keyin ko'tariladi. |
| `desktopMultiplex` | `false` | Multiplex'da view-only'ni server tekshiradi; oddiy relay'da agent (rights bo'yicha). Bitta ma'lum yo'l qoldiriladi. |
| `webRTC` | `false` | WebRTC brauzer-agent oqimini gateway'dan chetlab o'tadi. |
| `allowLoginToken` | `false` | Login token brauzerga upstream credential beradi (taqiqlangan). |
| `allowFraming` | `false` | `X-Frame-Options` default `sameorigin`; framing yoqilmaydi. |
| `cookieIpCheck` | `strict` | Sessiya cookie'si IP'ga bog'lanadi (webserver.js:11184). |
| `maxInvalidLogin` | `10 / 10 / 10`, `blocking: ip`, `exclude: 127.0.0.1,::1` | Default `iprange` (/24) o'rniga aniq IP (webserver.js:10892-10971). Istisno faqat loopback (konteyner ichidagi CLI/healthcheck). Compose'da gateway trafigi va service account login'i `api` IP'sidan (`API_IP`) keladi — u istisno emas: brauzer so'rovlari `trustedProxy` orqali X-Forwarded-For dagi mijoz IP'siga yoziladi, service account'ning noto'g'ri login'lari esa `api` IP'siga hisoblanib, 10 tadan keyin uni 10 daqiqaga bloklaydi. |
| `domains[''].newAccounts` | `false` | Ro'yxatdan o'tish yopiq; `newAccountsUserGroups`/`newAccountsRights` berilmaydi. |
| `domains[''].passwordRequirements` | `min 16, max 128`, har sinfdan 1, `loginTokens: false` | `adduser` bu talablarni siteadmin uchun ham tekshiradi (meshuser.js:6376). |

## Docker image (compose)

[Dockerfile](Dockerfile) ishga tushishda [entrypoint.sh](entrypoint.sh) ni bajaradi:

1. `render-config.mjs` — shablon + PostgreSQL (`MESHCENTRAL_DB_PASSWORD_FILE`) + `cert`/`port` + `trustedProxy` (`MESHCENTRAL_TRUSTED_PROXY`, faqat IP literal) → `meshcentral-data/config.json`.
2. `netschool-svc` service account: DB'da yo'q bo'lsa `--createaccount … --pass=<MESHCENTRAL_SERVICE_PASSWORD_FILE>`; site administrator bo'lmasa `--adminaccount`. Ikkalasi asosiy server ishga tushishidan oldin (CLI faqat to'xtagan serverda ishlaydi). Mavjud account'ga va uning paroliga tegilmaydi; parol logga chiqmaydi.
3. `root-cert-public.crt` paydo bo'lgach (≤ 120 s) uni `/run/meshcentral-ca` (`meshcentral-ca` volume, api'da read-only) ga atomik nusxalaydi — faqat public sertifikat.
4. `exec node meshcentral.js`.

Parollar `generateMeshPassword()` dan (`@netschool/meshcentral-adapter`): `base64url(32 bayt) + "-Aa1"`. `_` nonalpha hisoblanmaydi, shuning uchun `-Aa1` qo'shimchasi har sinfdan belgini kafolatlaydi.

## Yangilash tartibi

Arxitektura §5.3: upstream review → alohida branch → adapter contract testlari → OS integratsiya testlari → bitta sinf canary.

1. Alohida branch oching.
2. `cd upstream && git fetch && git checkout <yangi-commit>`.
3. `upstream.lock.json` ni (commit, packageVersion) yangilang.
4. Testlardan keyin submodule o'zgarishini va lock faylni bitta commit qiling.

MeshCentral'ga o'zgartirish kerak bo'lsa, `upstream/` ni tahrirlamang: alohida `meshcentral-fork` da kichik commit qiling va submodule URL'ini shunga o'tkazing.
