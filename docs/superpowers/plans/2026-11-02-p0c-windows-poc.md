# P0c — OS PoC (Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Butun zanjirni haqiqiy Windows kompyuterda sinash. Natija capability matrix'ga yoziladi; hech bir OS sinovsiz "qo'llanadi" deb belgilanmaydi.

Zanjir:
1. MeshAgent va Companion o'rnatiladi va ro'yxatdan o'tadi (enrollment).
2. Inventory va bog'lash.
3. Ko'rish (view), boshqarish (control), revoke.
4. Quvvat: o'chirish, qayta yuklash, uxlatish, yoqish.
5. Dars buyruqlari va miniatura.

Sinovni egasi o'tkazadi; bu reja buning uchun to'plam tayyorlaydi:
- pin qilingan oflayn agent keshi;
- LAN'dagi test kompyuterlari ulanadigan compose PoC rejimi;
- agent o'rnatuvchisini olish uchun CLI;
- Windows uchun portable Companion;
- hub'ni UI'siz boshqarish uchun skript va avtomatik tekshiruvchi;
- runbook.

**Architecture:**
- **Hub** egasining Mac'ida `infra/compose` bilan ishlaydi, `compose.poc.yaml` overlay qo'shiladi:
  - MeshCentral faqat **agent porti**ni (`agentPort` 4433) LAN'ga ochadi; admin UI ichkarida qoladi.
  - Agent `.msh` faylidagi server manzili `agentAliasDNS`/`agentAliasPort` bilan Mac'ning LAN nomiga yoziladi. API'ning `meshcentral` hostname tekshiruvi o'zgarmaydi; agent serverni sertifikat hash'i (`ServerID`) bo'yicha tanib oladi.
- **Agent binary'lari:** MeshCentral git repo'sida Windows binary'lari yo'q. Ular pin qilingan npm `meshcentral@<packageVersion>` tarball'idan olinadi: tarball integrity va har fayl sha256'i `upstream.lock.json`da. Oflayn kesh image'ga ko'chiriladi.
- **Companion** Windows'da installer'siz (P2e) ishlaydi: Electron `win32-<arch>` zip va `resources/app` ichidagi bundle. `enroll` o'sha Electron'ning `ELECTRON_RUN_AS_NODE` rejimida.
- **Hub boshqaruvi:** admin sahifalari (P1f2) hali yo'q, shuning uchun `scripts/poc/hubctl.mjs` API orqali ishlaydi: xona, enrollment token, mesh bog'lash, dars.
- **Tekshiruv:** `scripts/poc/verify.mjs` avtomatik tekshiriladigan qadamlarni API orqali o'tkazib JSON natija yozadi. Ko'z bilan tekshiriladiganlari runbook'dagi qo'lda checklist.

**Tech Stack:**
- mavjud stek;
- `tar` (Node ichki emas): `node:zlib` gunzip va minimal ustar o'quvchi, yangi dependency yo'q;
- Electron 45.2.1 Windows zip'i `@electron/get` orqali (electron paketining dependency'si).

**Spec:** [docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md](../../architecture/NETSCHOOL_ARCHITECTURE_v1.md):
- §5.2: majburiy PoC bandlari;
- §5.3: upstream lock, agent manifest;
- §7: capability matrix, "sinovsiz qo'llanadi deb belgilanmaydi";
- §7.1: quvvat;
- §15.1.

Yo'l xaritasi: [P0c](2026-10-27-netschool-roadmap.md). Oldingi qarorlar: [ADR 0003](../../adr/0003-session-gateway.md), [0008](../../adr/0008-remote-sessions.md), [0009](../../adr/0009-companion.md), [0010](../../adr/0010-power-management.md).

**Egasining qarorlari (2026-11-02):**
- Sinov kompyuteri: faqat **Windows 10/11** (VM yoki fizik). macOS, Linux X11 va Wayland hozircha yo'q: matrix'da "sinovdan o'tmagan" bo'lib qoladi.
- Hub egasining Mac'ida docker compose bilan ishlaydi. Mac'ning o'ziga agent yoki Companion o'rnatilmaydi, u qayta yuklanmaydi.
- MDM yo'q (P2h).

## Global Constraints

- Hech bir avtomatik test egasining Mac'ida ekran ko'rsatmaydi, agent o'rnatmaydi va OS sozlamasini o'zgartirmaydi.
- `upstream/` tahrirlanmaydi (§5.3). Agent binary'lari repoga commit qilinmaydi: `infra/meshcentral/agent-cache/` gitignored, faqat manifest (`upstream.lock.json`) commit qilinadi.
- **Integrity:** tarball `dist.integrity` (sha512) va har binary sha256'i lock bilan aynan teng bo'lishi shart. Mos kelmasa skript nolga teng bo'lmagan kod bilan to'xtaydi va keshga hech narsa yozmaydi.
- **TLS tekshiruvi o'chirilmaydi:**
  - `hubctl`/`verify` hub CA'sini `--ca` bilan oladi;
  - Windows'dagi Companion `enroll --ca`.
- **Agent arxitekturalari:** `x64` → MeshCentral id 4 (`MeshService64.exe`), `arm64` → id 43 (`MeshServiceARM64.exe`). Apple Silicon'dagi Windows VM odatda `arm64`.
- **Matrix holatlari:** `passed | failed | partial | not_tested`. Har `passed` uchun runbook qadami va natija fayli havolasi bo'lishi shart.

## Review Focus

1. **Tarball yoki binary almashtirilgan** (mirror, MITM) → kesh yozilmaydi, image eski yoki bo'sh kesh bilan build qilinmaydi. → Task 1 `an integrity mismatch writes nothing`, `a binary hash mismatch writes nothing`.
2. **`agentAliasDNS` Mac'ning noto'g'ri yoki o'zgaruvchan IP'si** (DHCP) → agent ulanmaydi. Runbook DNS nomi yoki qat'iy IP talab qiladi; `verify` agent offline bo'lsa aniq sabab chiqaradi. → Task 2 `agent alias settings are rendered`; Task 5 `verify reports an offline agent with the alias it should reach`.
3. **Admin UI tasodifan LAN'ga ochiladi** → overlay faqat agent portini publish qiladi. → Task 2 `the poc overlay publishes only the agent port of meshcentral`.
4. **Companion zip boshqa arxitektura uchun** (ARM64 VM'da x64 Electron emulatsiyada sekin yoki capture ishlamaydi) → `pack` arxitekturani aniq oladi, zip nomida ko'rsatadi; runbook VM arxitekturasini tekshirishni birinchi qadam qiladi. → Task 4 `the zip name and Electron binary match the requested arch`.
5. **Sinov natijasi qo'lda noto'g'ri yozilsa** (masalan `passed`, lekin dalil yo'q) → `verify --check-matrix` dalil havolasiz `passed`ni rad etadi. → Task 6 `a passed cell without evidence fails the matrix check`.

---

### Task 0: Branch

- [ ] **Step 1:** `git switch main && git pull --ff-only && git switch -c p0c-windows`. Shu rejani commit qilish: `docs: P0c Windows PoC plan`.

### Task 1: Pin qilingan oflayn agent keshi

**Files:**
- Create: `scripts/meshcentral/fetch-agents.mjs`, `scripts/meshcentral/tar.mjs` (minimal ustar o'quvchi)
- Modify: `infra/meshcentral/upstream.lock.json` (`agentManifest`), `infra/meshcentral/Dockerfile` (keshni `agents/` ga nusxalash), `.gitignore` (`infra/meshcentral/agent-cache/`), root `package.json` (`"meshcentral:agents": "node scripts/meshcentral/fetch-agents.mjs"`), `infra/meshcentral/README.md`
- Test: `infra/meshcentral/test/fetch-agents.test.ts`

**Interfaces — Produces:**

```typescript
// upstream.lock.json → agentManifest
{ source: 'npm', package: 'meshcentral', version: '1.3.1', tarball: string, integrity: 'sha512-…',
  files: [{ id: 4, name: 'MeshService64.exe', sha256: string, bytes: number }, { id: 43, name: 'MeshServiceARM64.exe', … }] }
// fetch-agents.mjs
export async function fetchAgents(opts: { lock: AgentManifest; outDir: string; fetchImpl?: typeof fetch; tarballPath?: string }): Promise<void>;
// tar.mjs
export function* readTar(buf: Buffer): Generator<{ name: string; data: Buffer }>; // ustar, faqat oddiy fayllar
```

- Tarball fayllari `package/agents/<name>` ostida.
- `--update-lock` rejimi (faqat lock yangilash uchun): tarball'ni yuklab, integrity'ni registry'dagi qiymat bilan tekshiradi va `files` hash'larini lock'ga yozadi.
- Oddiy rejim faqat lock'dagi qiymatlar bilan tekshiradi va `outDir`ga yozadi. Avval vaqtinchalik katalogga yozib, keyin atomik rename qiladi.

- [ ] **Step 1: Failing testlar** (kichik soxta tgz test ichida yasaladi):
  - `extracts the listed agents and verifies their hashes`;
  - `an integrity mismatch writes nothing`;
  - `a binary hash mismatch writes nothing`;
  - `a missing listed file fails`;
  - `paths outside package/agents are ignored` (`../` bilan nom).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS.
- [ ] **Step 5:** `node scripts/meshcentral/fetch-agents.mjs --update-lock`. Lock'ga haqiqiy integrity va sha256 yoziladi, `pnpm meshcentral:agents` → kesh. `docker compose build meshcentral` → image ichida `agents/MeshService64.exe` bor.
- [ ] **Step 6:** Commit `feat(meshcentral): pinned offline agent cache`.

### Task 2: Compose PoC rejimi (agent porti LAN'ga)

**Files:**
- Create: `infra/compose/compose.poc.yaml`
- Modify: `infra/meshcentral/render-config.mjs` (`MESHCENTRAL_AGENT_PORT`, `MESHCENTRAL_AGENT_ALIAS_DNS`, `MESHCENTRAL_AGENT_ALIAS_PORT`), `infra/compose/README.md`
- Test: `infra/meshcentral/test/render-config.test.ts`, `infra/compose/test/compose.test.ts`

- `renderConfig(template, { …, agent?: { port: number; aliasDns: string; aliasPort: number } })` → `settings.agentPort`, `agentAliasDNS`, `agentAliasPort`. `aliasDns` — hostname yoki IP; `/`, `:`, `@` bo'lsa xato.
- Overlay:
  - `meshcentral.ports: ["${MESH_AGENT_BIND:-0.0.0.0}:4433:4433"]`;
  - `MESHCENTRAL_AGENT_ALIAS_DNS: ${MESH_AGENT_HOST:?…}`;
  - API `PUBLIC_ORIGIN` va `GATEWAY_PUBLIC_ORIGIN` Mac'ning LAN nomida.

- [ ] **Step 1: Failing testlar:**
  - `agent alias settings are rendered`;
  - `an alias with a port or path is rejected`;
  - `without agent settings nothing changes`;
  - compose: `the poc overlay publishes only the agent port of meshcentral` (`docker compose -f compose.yaml -f compose.poc.yaml config` chiqishida meshcentral uchun faqat 4433, 4430 yo'q).
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS. **Step 5:** Commit `feat(compose): poc mode exposing the meshcentral agent port`.

### Task 3: `mesh-agent-installer` CLI

**Files:**
- Create: `apps/api/src/cli/mesh-agent.ts`
- Modify: `apps/api/src/cli/run.ts`, `packages/meshcentral-adapter/src/device-groups.ts` (yangi) + `index.ts`
- Test: `packages/meshcentral-adapter/test/device-groups.test.ts`, `apps/api/test/cli.test.ts`, `tests/contracts/adapter.test.ts`

**Interfaces — Produces:**

```typescript
// adapter
export async function ensureDeviceGroup(client: MeshRequester, name: string): Promise<{ meshid: string }>; // meshes → bor bo'lsa o'sha; yo'q bo'lsa createmesh (meshtype 2)
export function agentDownloadPath(meshid: string, arch: 'x64' | 'arm64'): string; // /meshagents?id=4|43&meshid=<id without 'mesh//'>&installflags=0
// CLI: netschool-admin mesh-agent-installer --site <name> --arch x64|arm64 --out <file>
```

- CLI ishlash tartibi:
  - DB'dan site'ni topadi. `meshDomainId` null bo'lsa `''` qilib qo'yadi va audit yozadi.
  - Service account bilan (`MESHCENTRAL_*` env, CA bilan) `NetSchool — <site>` guruhini ta'minlaydi.
  - Installer'ni ichki MeshCentral URL'idan CA tekshiruvi bilan yuklaydi va `--out`ga yozadi.
- Chiqish kodlari: `0` muvaffaqiyat, `2` argument xato, `3` MeshCentral xatosi yoki 404 (agent keshi yo'q — xabarda `pnpm meshcentral:agents` aytiladi).
- Konteyner ichida: `docker compose exec api node dist/cli.mjs mesh-agent-installer … --out /tmp/x.exe`, keyin `docker compose cp`. Runbook shu buyruqlarni beradi.

- [ ] **Step 1: Failing testlar:**
  - `an existing group is reused, a missing one is created once` (fake requester);
  - `download path uses id 4 for x64 and 43 for arm64`;
  - cli: `unknown site exits 2`, `missing MeshCentral config exits 3`;
  - contract (real): `ensureDeviceGroup creates then reuses a group`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS. **Step 5:** Commit `feat(cli): download a site's MeshAgent installer`.

### Task 4: Windows uchun portable Companion

**Files:**
- Create: `apps/companion/scripts/pack-win.mjs`, `apps/companion/win/enroll.cmd`, `apps/companion/win/start.cmd`
- Modify: `apps/companion/package.json` (`"pack:win": "node scripts/pack-win.mjs"`), `apps/companion/README.md`
- Test: `apps/companion/test/pack-win.test.ts`

- `pack-win.mjs --arch x64|arm64`:
  - `@electron/get` bilan `electron-v45.2.1-win32-<arch>.zip`ni oladi (Electron o'zining sha256 tekshiruvi bilan);
  - oddiy (test emas) build'ni `resources/app/` ga qo'yadi (`package.json` `main: dist/main.cjs`);
  - `electron.exe`ni `NetSchool Companion.exe` deb nomlaydi;
  - `enroll.cmd` (`set ELECTRON_RUN_AS_NODE=1` → `"%~dp0NetSchool Companion.exe" "%~dp0resources\app\dist\enroll.mjs" %*`) va `start.cmd`ni qo'shadi;
  - natija: `apps/companion/out/netschool-companion-win32-<arch>.zip`.
- Test build (`NETSCHOOL_COMPANION_TEST_HIDDEN`) zip'ga kirmasligi tekshiriladi.

- [ ] **Step 1: Failing testlar** (`@electron/get` soxta, kichik zip bilan):
  - `the zip name and Electron binary match the requested arch`;
  - `the app bundle is a production build without the hidden test mode`;
  - `enroll.cmd runs enroll.mjs through Electron as Node`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `pnpm --filter @netschool/companion pack:win --arch arm64` → zip (haqiqiy yuklab olish, Mac'da hech narsa ishga tushirilmaydi). **Step 5:** Commit `feat(companion): portable Windows package for the PoC`.

### Task 5: `hubctl` va `verify`

**Files:**
- Create: `scripts/poc/{hub-client.mjs,hubctl.mjs,verify.mjs}`
- Test: `scripts/poc/test/{hubctl,verify}.test.ts` (`startTestApp` + `FakeMesh`)
- Modify: `vitest.config.ts` (`scripts/*/test/**/*.test.ts` unit'ga)

- `hub-client.mjs`: `--origin`, `--ca`, `--user`, parol `NETSCHOOL_PASSWORD` env'dan. Cookie sessiya, Origin header, `Idempotency-Key`.
- `hubctl` buyruqlari:
  - `room create <name>`;
  - `enrollment create --room <name>` (token stdout'ga, bir marta);
  - `mesh nodes`;
  - `mesh bind <hostname> <nodeId>`;
  - `teacher create <username> --room <name>` (vaqtinchalik parol);
  - `lesson start --room <name>`.
- `verify --room <name> --out docs/poc/results/windows-<sana>.json` avtomatik qadamlar, har biri `passed`/`failed` va dalil bilan:
  1. qurilma ro'yxatda, Companion `online`;
  2. capability hisoboti (`classroom.*`, thumbnails holati);
  3. MeshAgent `online` va bog'langan;
  4. dars → `message.show` → target `succeeded`;
  5. `overlay.lock` → `succeeded`, `overlay.unlock` → `succeeded`;
  6. miniatura: oxirgi kadr ≤2 s ichida;
  7. remote `view` sessiya ochiladi va ticket olinadi, `control` sessiya ochiladi, ikkinchi `control` → 409 `control_busy`, yopish → sessiya `closed`;
  8. `reboot` amali → `succeeded` (offline → online, ≤10 daqiqa).
- O'chirish, uxlatish va WoL `verify --power shutdown|sleep|wake` bilan alohida ishga tushiriladi (kompyuterni qayta yoqish qo'lda).
- Offline agent: xato matnida `agentAliasDNS:port` va "Windows'da `Test-NetConnection <host> -Port 4433`" ko'rsatiladi.

- [ ] **Step 1: Failing testlar:**
  - `hubctl creates a room, an enrollment token and binds a node`;
  - `verify passes on a healthy simulated device and writes evidence`;
  - `verify reports an offline agent with the alias it should reach`;
  - `a failed step does not stop later independent steps`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implement. **Step 4:** → PASS. **Step 5:** Commit `feat(poc): hub control and automated verification scripts`.

### Task 6: Runbook, capability matrix va matrix tekshiruvi

**Files:**
- Create: `docs/poc/README.md`, `docs/poc/runbook-windows.md`, `docs/poc/capability-matrix.md`, `docs/poc/risks.md`, `docs/poc/results/.gitkeep`
- Modify: `scripts/poc/verify.mjs` (`--check-matrix`), `.github/workflows/ci.yml` (unit ishida `node scripts/poc/verify.mjs --check-matrix`)
- Test: `scripts/poc/test/matrix.test.ts`

**Runbook bo'limlari** (har qadamda kutilgan natija va tekshiruv usuli):
1. Mac: `.env` (`MESH_AGENT_HOST`, `PUBLIC_ORIGIN`), sertifikat, `pnpm meshcentral:agents`, `docker compose -f compose.yaml -f compose.poc.yaml up -d`, `bootstrap`.
2. Windows: arxitekturani aniqlash (`echo %PROCESSOR_ARCHITECTURE%`), Mac'ga ulanish (`Test-NetConnection`).
3. MeshAgent: installer olish (Task 3) → Windows'da admin sifatida o'rnatish → `hubctl mesh nodes` → `mesh bind`.
4. Companion: zip (Task 4) → `enroll.cmd --hub … --ca …` (admin) → `start.cmd` (oddiy user sessiyasida).
5. `verify` (avtomatik) va qo'lda checklist:
   - view'da klaviatura ishlamaydi;
   - control'da sichqoncha va klaviatura ishlaydi;
   - revoke'dan keyin viewer uziladi;
   - overlay ko'rinadi va hub o'chganda ≤120 s da tushadi;
   - qayta yuklashdan keyin eskirgan lock qaytmaydi;
   - UAC/secure desktop, ko'p monitor, lock screen, foydalanuvchi almashtirish.
6. Quvvat: o'chirish (qo'lda yoqish), uxlatish, WoL (BIOS/NIC qo'llasa; VM'da odatda `wake_unsupported` yoki `unknown`).
7. Tozalash va ADR 0003 bo'yicha principal'lar qolmaganini tekshirish.

**Capability matrix:**
- Ustunlar: Windows x64, Windows ARM64, macOS, Linux X11, Linux Wayland.
- Qatorlar:
  - `enrollment`, `inventory`, `remote.view`, `remote.control`, `remote.revoke`;
  - `power.shutdown|reboot|sleep|wake`;
  - `classroom.message|overlay|help|thumbnails`;
  - `uac/secure-desktop`, `multi-monitor`.
- Har katak: holat + dalil havolasi (`results/<fayl>.json#step` yoki runbook checklist bandi).

`--check-matrix`:
- `passed` dalilsiz bo'lsa yiqiladi;
- dalil fayli mavjud bo'lmasa yiqiladi;
- noma'lum holat bo'lsa yiqiladi.
- Boshlang'ich holatda hamma katak `not_tested`.

- [ ] **Step 1: Failing testlar:**
  - `a passed cell without evidence fails the matrix check`;
  - `evidence must point to an existing results file`;
  - `the initial matrix is all not_tested and passes the check`.
- [ ] **Step 2:** → FAIL. **Step 3:** Hujjatlar va tekshiruv. **Step 4:** → PASS; `pnpm test`, `pnpm lint`, `pnpm typecheck` → PASS. **Step 5:** Commit `docs(poc): Windows runbook, capability matrix and risks`.

### Task 7: Egasi bilan sinov sessiyasi (qo'lda)

- [ ] **Step 1:** Egasi runbook bo'yicha Windows'da sinaydi; `verify` JSON natijasi `docs/poc/results/` ga tushadi, qo'lda checklist natijalari runbook shabloniga yoziladi.
- [ ] **Step 2:** Topilgan muammolar tuzatiladi (har biri test bilan, alohida commit) yoki `risks.md`ga yoziladi.
- [ ] **Step 3:** Matrix'ning Windows ustuni dalillar bilan to'ldiriladi; `--check-matrix` → PASS.
- [ ] **Step 4:** `upstream.lock.json`: `imageDigest` (`docker image inspect … --format '{{index .RepoDigests 0}}'` yoki lokal image ID; registry bo'lmasa izoh bilan), `agentManifest` sinovda ishlatilgan versiya.
- [ ] **Step 5:** ADR 0012 (`docs/adr/0012-os-poc-windows.md`): natijalar, cheklovlar, macOS/Linux kutilmoqda. Yo'l xaritasida P0c holati: "Windows bajarildi; macOS/Linux — mashina kerak". Commit `docs: record the Windows PoC results`.
