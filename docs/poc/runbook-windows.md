# Windows PoC runbook

**Muhit:** hub sizning Mac'ingizda (docker compose), test kompyuteri — alohida Windows 10/11 (VM yoki fizik). Mac'ga agent yoki Companion o'rnatilmaydi. Hamma buyruq repo ildizidan ishga tushiriladi, aks holda alohida aytilgan.

Natijalar `docs/poc/results/` ga yoziladi:
- `verify`ning JSON fayli;
- qo'lda tekshiruv yozuvi `windows-<arch>-<sana>-manual.md` (shablon 8-bo'limda).

## 1. Hub (Mac)

1. **LAN manzili.** Mac'ning LAN manzilini aniqlang: `ipconfig getifaddr en0` yoki routerda qat'iy IP yoki DNS nomi. Quyida `HUB` deb yozilgan.
2. **TLS sertifikati.**
   - `HUB` nomi uchun sertifikat va uning CA'si kerak. SAN'da `HUB` bo'lsin: nom bo'lsa `DNS:HUB`, IP bo'lsa `IP:HUB`. Test uchun o'z-o'zidan imzolangan sertifikat ham bo'ladi; uning o'zi CA bo'ladi.
   - Sertifikat `infra/compose/secrets/api_tls_cert`ga, kalit `infra/compose/secrets/api_tls_key`ga yoziladi.
   - Boshqa sirlar `infra/compose/README.md`dagidek.
3. **`infra/compose/.env`:**
   ```
   PUBLIC_ORIGIN=https://HUB
   GATEWAY_PUBLIC_ORIGIN=https://HUB:8444
   MESH_AGENT_HOST=HUB
   # Har `docker compose` buyrug'i overlay bilan: oddiy `up` agent portini va nuqtali nomni yo'qotmasin.
   COMPOSE_FILE=compose.yaml:compose.poc.yaml
   ```
4. **Agentlar va stack.** Compose buyruqlari subshell ichida, repo ildizida qolasiz:
   ```bash
   pnpm meshcentral:agents
   (cd infra/compose && docker compose up -d --build)
   (cd infra/compose && docker compose run --rm api-migrate node dist/cli.mjs bootstrap --org "PoC" --site "Bosh bino" --admin admin)
   (cd infra/compose && docker compose logs meshcentral | grep -E "agent-only|AMT")
   ```
   Logda `agent-only server running on port 4433` bo'lishi va AMT haqida xato bo'lmasligi kerak. Shu qatorni qo'lda tekshiruv yozuviga ham ko'chiring.
5. **Admin paroli.** Brauzerda `https://HUB` ni oching, `admin` bilan kiring va parolni almashtiring. Yangi parolni `NETSCHOOL_PASSWORD` sifatida ishlatasiz.
6. **Skriptlar uchun muhit** (zsh va bash'da bir xil ishlaydi):
   ```bash
   export NETSCHOOL_HUB_ORIGIN=https://HUB
   export NETSCHOOL_HUB_CA=$PWD/infra/compose/secrets/api_tls_cert
   export NETSCHOOL_HUB_USER=admin
   export NETSCHOOL_PASSWORD='<yangi parol>'
   node scripts/poc/hubctl.mjs room create Lab-1 --site "Bosh bino"
   ```

**Kutilgan natija:** `curl --cacert infra/compose/secrets/api_tls_cert https://HUB/api/v1/healthz` → `"mesh":"ok"`.

## 2. Windows: tayyorgarlik

1. **Arxitektura.** `cmd`da `echo %PROCESSOR_ARCHITECTURE%` ni ishga tushiring: `AMD64` bo'lsa → `x64`, `ARM64` bo'lsa → `arm64`. Apple Silicon'dagi VM odatda `arm64`.
2. **Tarmoq.** PowerShell'da ikkalasi `TcpTestSucceeded : True` bo'lishi kerak:
   ```powershell
   Test-NetConnection HUB -Port 443
   Test-NetConnection HUB -Port 4433
   ```
3. **CA.** CA faylini (`api_tls_cert`) Windows'ga `C:\NetSchool\hub-ca.pem` nomi bilan ko'chiring.

## 3. MeshAgent

1. **O'rnatuvchini olish (Mac'da, repo ildizidan):**
   ```bash
   (cd infra/compose && docker compose exec api node dist/cli.mjs mesh-agent-installer --site "Bosh bino" --arch <x64|arm64> --out /tmp/agent.exe)
   (cd infra/compose && docker compose cp api:/tmp/agent.exe ../../meshagent-<arch>.exe)
   ```
2. **O'rnatish.** `meshagent-<arch>.exe` ni Windows'ga ko'chiring va administrator sifatida ishga tushiring → **Install**.
3. **Ulanganini tekshirish (Mac'da):** `node scripts/poc/hubctl.mjs mesh nodes --site "Bosh bino"` chiqarganda Windows kompyuter `online` holatida ko'rinadi.

## 4. Companion

1. **Paket (Mac'da):** `pnpm --filter @netschool/companion pack:win --arch <x64|arm64>` → `apps/companion/out/netschool-companion-win32-<arch>.zip`.
2. **Yoyish.** Zip'ni Windows'da `C:\NetSchool\companion\` ga yoying.
3. **Enrollment token (Mac'da):** `node scripts/poc/hubctl.mjs enrollment create --room Lab-1`.
4. **Ro'yxatdan o'tkazish (Windows, administrator `cmd`):**
   ```
   set NETSCHOOL_ENROLL_TOKEN=nse_...
   C:\NetSchool\companion\enroll.cmd --hub https://HUB --ca C:\NetSchool\hub-ca.pem
   ```
   Chiqish kodi `0` bo'lishi kerak.
5. **Ishga tushirish.** Oddiy foydalanuvchi sessiyasida `start.cmd` ni oching. Tray'da NetSchool belgisi chiqadi.
6. **Bog'lash (Mac'da):** `node scripts/poc/hubctl.mjs mesh bind <Windows hostname> <nodeId>`. `nodeId` 3-bo'limdagi `mesh nodes` chiqishidan olinadi.

## 5. Avtomatik tekshiruv

```bash
node scripts/poc/verify.mjs --room Lab-1 --agent-host HUB:4433 \
  --out docs/poc/results/windows-<arch>-$(date +%F).json
```

`verify` quyidagilarni tekshiradi: `device_found`, `device_enrolled`, `capabilities`, `agent_bound`, `message`, `overlay`, `thumbnail`, `remote`. Hammasi `PASS` bo'lishi kerak. `FAIL` bo'lsa xatoda sabab va keyingi qadam yoziladi (masalan `Test-NetConnection`).

## 6. Qo'lda tekshiruv (o'qituvchi panelida)

Panelga `https://HUB` orqali kiring. Dars `verify` ochgan holda qoladi. Har bandni `results/windows-<arch>-<sana>-manual.md` ga **ha/yo'q va izoh** bilan yozing.

1. **Xabar.** "Xabar yuborish" bosilganda Windows ekranida xabar oynasi chiqadi.
2. **Bloklash.**
   - "Bloklash" bosilganda ekranni yumshoq overlay qoplaydi: barcha monitorlarni, taskbar va Alt+Tab ustidan.
   - "Ochish" bosilganda overlay yo'qoladi.
3. **Lease tugashi.** Bloklash yoqiq holda hub to'xtatilsa (`docker compose stop api`), overlay ≤120 s ichida o'zi tushadi. Keyin `docker compose start api`.
4. **Reboot.** Bloklash yoqiq holda Windows qayta yuklansa, kirishdan keyin eskirgan lock qaytmaydi.
5. **Yordam.** O'quvchi tray yoki holat oynasidan "Yordam" bossa, plitkada ✋ belgisi chiqadi; o'qituvchi uni yopa oladi.
6. **Miniatura.** Plitkadagi rasm Windows ekrani bilan ~1–2 s ichida mos keladi.
7. **Ko'rish.** Panelda Windows ekrani ko'rinadi, lekin klaviatura va sichqoncha **ishlamaydi**.
8. **Boshqarish.** Sichqoncha va klaviatura ishlaydi. Shu vaqtda ikkinchi o'qituvchi (yoki ikkinchi brauzer) boshqarishni so'rasa, "boshqa foydalanuvchi boshqaryapti" chiqadi.
9. **Revoke.** Panel yopilsa yoki dars tugatilsa, viewer ≤10 s ichida uziladi.
10. **UAC.** Windows'da UAC so'rovi (secure desktop) ochilsa, control vaqtida nima ko'rinishini yozing. Kutilgan cheklov: secure desktop ko'rinmasligi mumkin.
11. **Ko'p monitor** (bo'lsa). Ko'rish, boshqarish va overlay barcha monitorlarda ishlaydi.
12. **Lock screen va foydalanuvchi almashtirish.** Windows qulflansa (Win+L) yoki foydalanuvchi almashtirilsa, Companion va miniatura holati qanday bo'lishini yozing.

## 7. Quvvat

Har biri alohida, kompyuter qayta yoqilgach keyingisi:

```bash
node scripts/poc/verify.mjs --room Lab-1 --power reboot   --out docs/poc/results/windows-<arch>-<sana>-reboot.json
node scripts/poc/verify.mjs --room Lab-1 --power sleep    --out docs/poc/results/windows-<arch>-<sana>-sleep.json
node scripts/poc/verify.mjs --room Lab-1 --power shutdown --out docs/poc/results/windows-<arch>-<sana>-shutdown.json
# keyin Windows'ni o'chirilgan holda qoldirib:
node scripts/poc/verify.mjs --room Lab-1 --power wake     --out docs/poc/results/windows-<arch>-<sana>-wake.json
```

- `shutdown` va `sleep` ≤3 daqiqada, `reboot` ≤10 daqiqada natija berishi kerak.
- **Uxlatish:** uyg'otishni qo'lda qiling.
- **Yoqish (WoL)** faqat BIOS/NIC qo'llasa va o'sha LAN segmentida boshqa yoqiq agent bo'lsa ishlaydi. VM'da odatda ishlamaydi: natija `wake_unsupported` yoki `unknown` bo'ladi. Buni matrix'da `failed` yoki `partial` qilib izoh bilan yozing.
- **Kompyuterni qayta yoqish:** shutdown'dan keyin o'zingiz yoqasiz. `verify` buni kutmaydi.
- `--power` ishga tushirilganda faqat qurilma qidiriladi va quvvat qadami bajariladi; boshqa qadamlar o'tkazib yuboriladi (kompyuter o'chiq bo'lishi mumkin).
- `verify` natijani oxirida yozadi: kutish paytida Ctrl-C bosilsa dalil saqlanmaydi.

## 8. Qo'lda tekshiruv shabloni

```markdown
# Windows <arch> — qo'lda tekshiruv (<sana>)
Windows versiyasi: …  ·  VM/fizik: …  ·  Monitorlar: …
| # | Band | Natija (ha/yo'q/qisman) | Izoh |
|---|---|---|---|
| 1 | Xabar | | |
| 2 | Bloklash/ochish | | |
| … | | | |
```

## 9. Tozalash

1. Darsni tugating (panelda "Darsni tugatish"). Shundan keyin ochiq remote sessiya qolmasligi kerak: `verify` sessiyalarni o'zi yopadi, dars tugashi qolganlarini yopadi (ADR 0008).
2. Windows'da MeshAgent'ni o'chiring: `meshagent-<arch>.exe` → **Uninstall**. `C:\NetSchool` va `%ProgramData%\NetSchool` ni ham o'chiring.
3. Mac'da `(cd infra/compose && docker compose down)`. Ma'lumotni ham o'chirish uchun `-v` qo'shing.
