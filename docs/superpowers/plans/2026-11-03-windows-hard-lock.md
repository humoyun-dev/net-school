# Kuchli bloklash (Windows) — amalga oshirish rejasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O'qituvchi bloklaganda Windows talaba kompyuterida Win, Alt+Tab, Ctrl+Esc, Alt+F4, Ctrl+Shift+Esc umuman ishlamasin, Ctrl+Alt+Del ekranida faqat "Отмена" qolsin. Overlay lease'i (120 s) tugasa yoki dars tugasa hammasi o'zi qaytsin.

**Architecture:** Ikki yangi Windows binari, Go'da (`apps/os-helper`):
- `netschool-keyguard.exe` — talaba sessiyasida Companion ishga tushiradigan low-level klaviatura ilgagi. Bloklash paytida inject qilinmagan barcha tugmalarni yutadi. O'qituvchining MeshCentral kiritishi inject qilingan, shuning uchun o'tadi.
- `netschool-helper.exe` — SYSTEM Windows xizmati (P2d'ning birinchi qismi). Bloklash paytida HKLM siyosatlarini qo'yadi (DisableTaskMgr, Ctrl+Alt+Del menyusi bandlari) va qaytaradi.

Helper'ni o'quvchi aldab ochib qo'ya olmasligi uchun u faqat **hub imzolagan overlay holatiga** ishonadi:
- Hub heartbeat javobiga Ed25519 imzoli `overlayProof` qo'shadi.
- Companion uni named pipe orqali helper'ga uzatadi.
- Helper imzo, `deviceId` va `issuedAtMs` o'sishini tekshiradi.
- Imzolangan holat kelmasa, lease tugaganda siyosatlar qaytariladi (fail-open, spec §10).

**Tech Stack:**
- Go: oxirgi barqaror versiya, `go.mod` va CI'da pinlanadi. Bog'liqliklar: `golang.org/x/sys/windows` (`svc`, `registry`) va `github.com/Microsoft/go-winio` (SDDL'li named pipe).
- Mavjud qismlar: NestJS API, zod contracts, Electron Companion, vitest.
- Go Mac'ga o'rnatilmaydi: build va test Docker `golang` image'ida, CI'da `actions/setup-go`.

**Spec:** Spec hujjati yo'q; asoslar:
- `docs/superpowers/plans/2026-10-27-netschool-roadmap.md` — P0c holati, P2d, P2h;
- `docs/adr/0012-windows-poc-results.md` va `docs/poc/results/windows-x64-2026-11-03-manual.md` (2-band, qochish testi);
- egasining talabi: "2, 4, 5 ishladi bu xafli ular umuman ishlamasligi kerak"; laboratoriyalarda Windows 10 va 11, Pro va Home.

## Global Constraints

- Maqsadli OS: Windows 10 va 11, Pro va Home. Keyboard Filter, AppLocker va GPO'ga tayanilmaydi (Home'da yo'q).
- Overlay lease 120 s (`OVERLAY_LEASE_MS`); helper lease'ni 130 s dan uzun qabul qilmaydi.
- Hub uzilsa yoki helper/Companion o'lsa, bloklash cheksiz qolmaydi: siyosatlar lease oxirida yoki xizmat qayta ishga tushganda qaytariladi.
- Bloklashdan oldin turgan ma'mur siyosat qiymatlari (masalan maktab qo'ygan `DisableTaskMgr=1`) qaytarishda aynan tiklanadi.
- Ochish faqat hub imzolagan holat bilan yoki lease tugashi bilan bo'ladi; pipe orqali imzosiz "ochish" yo'q.
- Capability: helper va keyguard ishlasa `classroom.overlay` = `{state:'available', enforcement:'hard'}`, aks holda `'soft'`. Hech qachon tekshirilmagan holda `hard` deyilmaydi.
- Ish Mac'iga hech narsa o'rnatilmaydi va OS sozlamasi o'zgartirilmaydi. Windows'dagi barcha qo'lda sinovlarni egasi bajaradi.
- Matnlar: kod izohlari o'zbekcha (repo uslubi), commit oxirida `Claude-Session` qatori.

## Review Focus

1. **Eski imzoli "ochiq" holatni qayta yuborish (replay).** `issuedAtMs` oxirgi qabul qilinganidan katta bo'lmasa rad etiladi (Task 3 testi `rejects a replayed older unlock`).
2. **Siyosatlar qo'yilgan holatda helper o'ldi yoki kompyuter reboot bo'ldi.** Xizmat ishga tushganda write-ahead holat faylidan qaytaradi (Task 4 testi `start reverts a leftover lock`).
3. **Hub yetib bo'lmaydi.** Yangi imzoli holat kelmasa, siyosatlar lease oxirida qaytadi (Task 3 testi `lease expiry reverts`).
4. **Ma'mur oldindan qo'ygan qiymat.** Qaytarishdan keyin qiymat va turi avvalgidek, qiymat yo'q bo'lgan bo'lsa yo'q (Task 4 testi `revert restores prior values exactly`).
5. **Pipe'ga yomon kiritish.** Begona `deviceId`, buzilgan imzo, noto'g'ri JSON yoki 4 KiB'dan uzun qator holatni o'zgartirmaydi; ulanish yopiladi (Task 5 testi `protocol rejects malformed input`).

---

## Fayl tuzilmasi

```
apps/os-helper/                      Go moduli (pnpm workspace emas)
  go.mod
  internal/lockstate/                imzo, tartib, lease — sof mantiq, har OS'da test
  internal/policy/                   Store interfeysi, snapshot/apply/revert, write-ahead holat fayli
    registry_windows.go              HKLM Store (x/sys/windows/registry)
  internal/protocol/                 pipe qator protokoli (JSON, ≤4 KiB), har OS'da test
  internal/keyguard/                 shouldSwallow(vk, flags) — sof; hook_windows.go
  cmd/netschool-helper/              xizmat: engine + pipe + svc (windows)
  cmd/netschool-keyguard/            hook + message loop (windows)
  scripts/build.sh                   Docker golang: GOOS=windows GOARCH=amd64|arm64 → dist/
packages/contracts/src/api/v1/devices.ts   overlayProof, claim javobida overlayPublicKey
apps/api/src/modules/devices/overlay-proof.ts   imzolash
apps/api/src/modules/devices/presence.service.ts heartbeat'ga proof
apps/api/src/config/config.ts               OVERLAY_SIGNING_KEY(_FILE)
apps/companion/src/core/helper-client.ts    pipe klienti
apps/companion/src/core/hard-lock.ts        overlay holati → helper + keyguard
apps/companion/src/main/keyguard.ts         keyguard jarayonini boshqarish
apps/companion/src/cli/enroll.ts            helper.json yozish
apps/companion/scripts/pack-win.mjs         helper/keyguard exe va cmd skriptlar
docs/adr/0013-windows-hard-lock.md, docs/poc/*
```

---

### Task 1: Windows'da siyosatlarni sinash (qo'lda, egasi bilan)

Dizayn shu natijaga bog'liq: HKLM siyosatlari qayta kirishsiz darhol ishlashi kerak.

**Files:**
- Create: `docs/poc/scripts/hard-lock-spike.cmd` (`apply` va `revert` argumentlari; `reg add` va `reg delete`)
- Create: `docs/poc/results/windows-x64-2026-11-0X-hard-lock-spike.md`

Sinaladigan to'plam (`POLICY_SET`, keyingi tasklar shu ro'yxatni ishlatadi):

| Kalit (HKLM) | Qiymat | Kutilgan ta'sir |
|---|---|---|
| `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\DisableTaskMgr` | DWORD 1 | Vazifalar menejeri ochilmaydi, CAD menyusidan yo'qoladi |
| `…\Policies\System\DisableLockWorkstation` | DWORD 1 | CAD "Заблокировать" va Win+L yo'q |
| `…\Policies\System\DisableChangePassword` | DWORD 1 | CAD "Изменить пароль" yo'q |
| `…\Policies\System\HideFastUserSwitching` | DWORD 1 | CAD "Сменить пользователя" yo'q |
| `…\Policies\Explorer\NoLogoff` | DWORD 1 | CAD "Выйти" yo'q |
| `…\Policies\Explorer\NoClose` | DWORD 1 | CAD'dagi quvvat tugmasi yo'q |

- [ ] **Step 1:** Skriptni yozing. `apply` har qiymatni qo'yadi; `revert` ularni o'chiradi. Skript faqat sinov mashinasi uchun, oldingi qiymatni saqlamaydi, bu fayl boshida yozilgan.
- [ ] **Step 2:** Egasi Windows 11'da (`DESKTOP-NAF58T0`) administrator sifatida `apply` qiladi, **qayta kirmasdan** Ctrl+Alt+Del bosadi va skrinshot yuboradi.
  Expected: faqat "Отмена" (va ehtimol tarmoq yoki maxsus imkoniyatlar belgisi); Ctrl+Shift+Esc Vazifalar menejerini ochmaydi.
- [ ] **Step 3:** `revert`, keyin yana Ctrl+Alt+Del.
  Expected: barcha bandlar qaytgan, qayta kirish talab qilinmagan.
- [ ] **Step 4:** Windows 10 va Home mashinasi bo'lsa, xuddi shu sinov. Bo'lmasa, natijada `not_tested` deb yozing.
- [ ] **Step 5:** Natijani yozib commit qiling.
  - Biror qiymat qayta kirishsiz ishlamasa, uni `POLICY_SET`dan chiqarib Ruling yozing.
  - Asosiy uchtasi (DisableTaskMgr, HideFastUserSwitching, NoLogoff) qayta kirishsiz ishlamasa, **to'xtang** va egasi bilan yondashuvni qayta ko'ring.

```bash
git add docs/poc/scripts/hard-lock-spike.cmd docs/poc/results/
git commit -m "docs(poc): Windows hard lock policy spike"
```

### Task 2: Hub imzolagan overlay holati

**Files:**
- Modify: `packages/contracts/src/api/v1/devices.ts` — `heartbeatResponseSchema`, `claimResponseSchema`
- Create: `apps/api/src/modules/devices/overlay-proof.ts`
- Modify: `apps/api/src/modules/devices/presence.service.ts`, `apps/api/src/config/config.ts`, `infra/compose/*` (secret `overlay_signing_key`), `apps/api/test/support/*` (test kaliti)
- Test: `apps/api/test/devices/overlay-proof.test.ts`, mavjud heartbeat va claim testlari, `tests/contracts`

**Interfaces:**
- Produces (contracts):
  - `overlayProofSchema = z.object({ deviceId: z.uuid(), lessonId: z.uuid().nullable(), locked: z.boolean(), sequence: z.string().regex(/^\d{1,30}$/).nullable(), leaseMs: z.number().int().positive(), issuedAtMs: z.number().int().positive(), signature: z.string() })`;
  - `heartbeatResponseSchema` ga `overlayProof: overlayProofSchema` (majburiy);
  - `claimResponseSchema` ga `overlayPublicKey: z.string()` (SPKI DER, base64url).
- Produces (imzo kiritmasi, Go va TS bir xil): `overlayProofInput(p) = "NSOVL1\n" + deviceId + "\n" + (lessonId ?? "-") + "\n" + (locked ? "1" : "0") + "\n" + (sequence ?? "-") + "\n" + leaseMs + "\n" + issuedAtMs` (UTF-8).
- Produces (api): `class OverlaySigner { constructor(privateKeyPem: string, now?: () => number); publicKey(): string; sign(p: Omit<OverlayProof,'signature'|'issuedAtMs'>): OverlayProof }`. `issuedAtMs = max(now(), last + 1)` — jarayon ichida qat'iy o'sadi.

- [ ] **Step 1: Failing testlar.**
  - `overlay-proof.test.ts`: `signs a verifiable proof` — `crypto.verify(null, overlayProofInput(p), publicKey, signature) === true`.
  - `issuedAtMs strictly increases within the process` — bir xil `now` bilan ikki marta imzolanganda ikkinchisi katta.
  - Heartbeat testi: darsdan tashqari qurilma `overlayProof.locked === false && lessonId === null`; bloklangan dars `locked === true`, `sequence` dars qatoridagi bilan teng, `leaseMs === 120000`.
  - Claim testi: `overlayPublicKey` imzoni tekshiradigan kalit.
- [ ] **Step 2:** `pnpm vitest run --project api overlay-proof heartbeat claim` → FAIL (`overlayProof` yo'q).
- [ ] **Step 3:** Imzolashni amalga oshiring.
  - Config: `OVERLAY_SIGNING_KEY`, PKCS8 PEM, `*_FILE` qo'llanadi. Productionda majburiy (yo'q bo'lsa ishga tushmaydi); testda `test/support` vaqtinchalik kalit yaratadi.
  - Compose: `infra/compose/secrets/overlay_signing_key` gitignored; yaratish buyrug'i `infra/compose/README` ga.
  - Kontrakt harness (`tests/contracts/harness/api.ts`) ham kalit oladi.
- [ ] **Step 4:** `pnpm vitest run --project api` va `pnpm vitest run --project contracts` → PASS.
- [ ] **Step 5:** Commit: `feat(api): signed overlay state in the device heartbeat`.

### Task 3: Go moduli va `lockstate`

**Files:**
- Create: `apps/os-helper/go.mod`, `apps/os-helper/internal/lockstate/{proof.go,engine.go}` + `_test.go`, `apps/os-helper/scripts/test.sh`
- Modify: `.github/workflows/ci.yml` — yangi `os-helper` job (`ubuntu-latest`: `go vet ./...`, `go test ./...`)

**Interfaces:**
- Produces:
  - `type Proof struct{ DeviceID string; LessonID *string; Locked bool; Sequence *string; LeaseMs int64; IssuedAtMs int64; Signature string }` (JSON teglari kontrakt nomlari bilan);
  - `func Verify(p Proof, pub ed25519.PublicKey, deviceID string) error`;
  - `type Engine struct` va `NewEngine(pub ed25519.PublicKey, deviceID string, lastIssuedAtMs int64, now func() time.Duration)`. `now` — monoton vaqt.
  - `func (e *Engine) Accept(p Proof) (Decision, error)`, `func (e *Engine) Tick() Decision`, `func (e *Engine) LastIssuedAtMs() int64`;
  - `type Decision int` — qiymatlar `NoChange`, `Apply`, `Revert`.
  - Lease: `min(p.LeaseMs, 130_000)`.

- [ ] **Step 1: Failing testlar** (`engine_test.go`). Kalit testda yaratiladi; TS bilan bir xil kiritma uchun Task 2'dagi TS imzolagan sobit vektor `testdata/proof.json` ga yoziladi.
  - `verifies a hub-signed vector` — `testdata/proof.json` → `Verify == nil`.
  - `rejects a wrong device, a bad signature, a lease of 0`.
  - `locked proof applies, unlocked proof reverts`.
  - `rejects a replayed older unlock` — issuedAt 100 bilan lock, keyin issuedAt 50 bilan unlock → xato, `NoChange`, bloklash qoladi.
  - `lease expiry reverts` — lease 120 000, `now` +120 s → `Tick() == Revert`; +119 s'da `NoChange`.
  - `lease is capped at 130 s` — `LeaseMs: 600000`, +130 s → `Revert`.
  - `renewal extends the lease` — +100 s'da yangi locked proof, +200 s'da hali `NoChange`.
- [ ] **Step 2:** `apps/os-helper/scripts/test.sh` (Docker `golang` image'ida `go test ./...`) → FAIL.
- [ ] **Step 3:** `proof.go` va `engine.go`.
- [ ] **Step 4:** `scripts/test.sh` → PASS; CI job qo'shilgan.
- [ ] **Step 5:** Commit: `feat(os-helper): verify hub-signed overlay state with a lease`.

### Task 4: `policy` — siyosatlarni qo'yish va aynan qaytarish

**Files:**
- Create: `apps/os-helper/internal/policy/{policy.go,state.go,registry_windows.go}` + `policy_test.go`, `registry_windows_test.go`
- Modify: `.github/workflows/ci.yml` — `os-helper` job'iga `windows-latest` matritsasi

**Interfaces:**
- Produces:
  - `type Value struct{ Path, Name string; Data uint32 }` va `var Set []Value` — Task 1'dagi `POLICY_SET`, yo'llar HKLM'ga nisbatan.
  - `type Prior struct{ Exists bool; Kind uint32; Raw []byte }`.
  - `type Store interface{ Get(path, name string) (Prior, error); SetDWORD(path, name string, v uint32) error; Restore(path, name string, p Prior) error }`.
  - `type Manager struct` va `NewManager(store Store, statePath string)`:
    - `Apply() error` — avval oldingi qiymatlarni `statePath` ga atomik yozadi (write-ahead), keyin qo'yadi; takror chaqirilsa snapshot qayta olinmaydi.
    - `Revert() error` — snapshot'dan tiklaydi, keyin holat faylini o'chiradi.
    - `Recover() error` — fayl bo'lsa `Revert`.
    - `Applied() bool`.
  - Holat fayli JSON: `{ "applied": true, "prior": [...], "lastIssuedAtMs": n }`.
  - `func OpenRegistry(root registry.Key) Store` (windows).

- [ ] **Step 1: Failing testlar** (`policy_test.go`, xotiradagi soxta Store bilan).
  - `apply sets every value in Set`.
  - `revert restores prior values exactly` — oldin `DisableTaskMgr` = 1 (ma'mur qo'ygan), `NoClose` yo'q edi; Apply, keyin Revert → `DisableTaskMgr` = 1 turibdi, `NoClose` yo'q.
  - `apply twice keeps the first snapshot`.
  - `start reverts a leftover lock` — Apply, keyin yangi Manager bilan `Recover()` → qiymatlar tiklangan, fayl yo'q.
  - `state is written before any value changes` — Store'ning birinchi `SetDWORD` chaqiruvida fayl allaqachon bor.
  - `registry_windows_test.go`: xuddi shu Revert testi haqiqiy registry'da, ildizi `HKCU\Software\NetSchoolTest\<random>` (CI runner'i administrator emas, HKLM'ga yozmaydi). Oxirida kalit o'chiriladi.
- [ ] **Step 2:** `scripts/test.sh` → FAIL.
- [ ] **Step 3:** Amalga oshiring. Holat fayli tmp fayl orqali yoziladi, keyin `rename`.
- [ ] **Step 4:** `scripts/test.sh` → PASS. CI'da Windows job registry testini o'tkazadi; buni PR'da tekshiring.
- [ ] **Step 5:** Commit: `feat(os-helper): apply and exactly revert lock policies`.

### Task 5: `netschool-helper` xizmati va pipe protokoli

**Files:**
- Create: `apps/os-helper/internal/protocol/{protocol.go,protocol_test.go}`, `apps/os-helper/cmd/netschool-helper/{main_windows.go,service.go,service_test.go}`

**Interfaces:**
- Consumes: `lockstate.Engine`, `policy.Manager`.
- Produces (protokol, bitta ulanish — bitta yoki ko'p qator, har qator ≤ 4096 bayt JSON):
  - so'rov `{"v":1,"op":"overlay.state","proof":Proof}` → javob `{"ok":true,"enforced":bool}`;
  - so'rov `{"v":1,"op":"status"}` → javob `{"ok":true,"enforced":bool,"version":"<semver>"}`;
  - xato → `{"ok":false,"error":"bad_request"|"rejected"}`, bad_request'dan keyin ulanish yopiladi.
- Produces:
  - `func Serve(l net.Listener, h Handler)`;
  - `type Handler interface{ State(lockstate.Proof) (enforced bool, err error); Status() (enforced bool) }`;
  - `type Service struct` — Handler + har 1 s `Tick`; `Start()` avval `Recover()`; `Stop()` → `Revert()`.
- Pipe: `\\.\pipe\netschool-helper`, SDDL `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)`.
- Konfiguratsiya: `%ProgramData%\NetSchool\helper\helper.json` = `{ "deviceId", "overlayPublicKey" }`, holat fayli shu papkada `state.json`.

- [ ] **Step 1: Failing testlar.**
  - `protocol_test.go` (`net.Pipe`):
    - `protocol rejects malformed input` — buzilgan JSON, `v:2`, noma'lum `op`, 5000 baytli qator → `bad_request`, Handler chaqirilmagan, ulanish yopilgan;
    - `state request reaches the handler and answers enforced`.
  - `service_test.go` (soxta Store, soxta monoton soat):
    - `locked proof applies policies`;
    - `tick after lease reverts`;
    - `stop reverts`;
    - `rejected proof leaves policies unchanged`;
    - `lastIssuedAtMs survives a restart` — Service qayta yaratilganda eski issuedAt bilan proof rad etiladi.
- [ ] **Step 2:** `scripts/test.sh` → FAIL.
- [ ] **Step 3:** Amalga oshiring.
  - `main_windows.go`: `svc.Run("NetSchoolHelper", …)`, go-winio `ListenPipe` SDDL bilan.
  - `helper.json` yo'q yoki buzilgan bo'lsa, xizmat xato bilan chiqadi va siyosat qo'ymaydi.
- [ ] **Step 4:** `scripts/test.sh` → PASS; `scripts/build.sh` `dist/windows-amd64/netschool-helper.exe` va `dist/windows-arm64/netschool-helper.exe` beradi.
- [ ] **Step 5:** Commit: `feat(os-helper): SYSTEM helper service behind an ACL'd pipe`.

### Task 6: `netschool-keyguard`

**Files:**
- Create: `apps/os-helper/internal/keyguard/{keyguard.go,keyguard_test.go,hook_windows.go}`, `apps/os-helper/cmd/netschool-keyguard/main_windows.go`

**Interfaces:**
- Produces:
  - `func ShouldSwallow(vk uint32, flags uint32) bool` — `LLKHF_INJECTED` (0x10) bo'lmagan har tugma uchun `true`;
  - Exe shartnomasi: stdin EOF bo'lsa (Companion o'lgan yoki yopgan) hook olinib, chiqish kodi 0; ishga tushgach stdout'ga `ready\n` yozadi.

- [ ] **Step 1: Failing test.** `swallows physical keys and passes injected ones`: `ShouldSwallow(0x5B /*LWin*/, 0) == true`, `ShouldSwallow(0x1B, 0) == true`, `ShouldSwallow(0x5B, 0x10) == false`.
- [ ] **Step 2:** `scripts/test.sh` → FAIL.
- [ ] **Step 3:** Hook va ishga tushirish.
  - `hook_windows.go`: `SetWindowsHookExW(WH_KEYBOARD_LL)` callback'i `runtime.LockOSThread` qilingan goroutine'da, `GetMessageW` sikli bilan.
  - Callback tez qaytishi shart: hook timeout'idan oshsa, Windows ilgakni jimgina olib tashlaydi.
- [ ] **Step 4:** `scripts/test.sh` → PASS; `scripts/build.sh` `netschool-keyguard.exe` beradi.
- [ ] **Step 5:** Commit: `feat(os-helper): low-level keyboard guard for the lock overlay`.

### Task 7: Companion — helper klienti, keyguard va `hard` capability

**Files:**
- Create: `apps/companion/src/core/helper-client.ts`, `apps/companion/src/core/hard-lock.ts`, `apps/companion/src/main/keyguard.ts`
- Modify: `apps/companion/src/core/agent.ts`, `apps/companion/src/core/capabilities.ts`, `apps/companion/src/core/hub-client.ts`, `apps/companion/src/main/main.ts`, `apps/companion/src/core/commands.ts`
- Test: `apps/companion/test/{helper-client,hard-lock}.test.ts`, `capabilities.test.ts`, `agent.test.ts`

**Interfaces:**
- Consumes:
  - Task 2 `overlayProof` (heartbeat javobida);
  - Task 5 protokoli;
  - Task 6 exe shartnomasi.
- Produces:
  - `class HelperClient { constructor(path: string, connect?: (path) => Duplex); state(proof: OverlayProof): Promise<{ enforced: boolean }>; status(): Promise<{ enforced: boolean; version: string } | null> }`:
    - timeout 2 s;
    - pipe yo'q bo'lsa `status()` → `null`.
  - `interface KeyguardRunner { start(): Promise<boolean>; stop(): void; running(): boolean }`:
    - `main/keyguard.ts` `spawn` bilan;
    - stdin pipe ochiq turadi;
    - `ready` 3 s ichida kelmasa `false`.
  - `class HardLock { constructor(deps: { helper: HelperClient | null; keyguard: KeyguardRunner | null }); onHeartbeat(proof: OverlayProof): Promise<void>; onOverlay(view: OverlayView): Promise<void>; enforcement(): 'hard' | 'soft' }`.
  - `PlatformFacts` ga `hardLock: boolean` qo'shiladi; `capabilityReport` `enforcement: f.hardLock ? 'hard' : 'soft'`.
  - Lock buyrug'i qo'llangach agent darhol navbatdan tashqari heartbeat yuboradi: helper imzoli holatni ~1 s ichida oladi.

- [ ] **Step 1: Failing testlar.**
  - `helper-client.test.ts` (soxta server, Mac'da unix socket):
    - `sends the proof line and reads enforced`;
    - `resolves null status when the pipe is absent`;
    - `times out after 2 s`.
  - `hard-lock.test.ts` (soxta runner va klient):
    - `locked view starts the keyguard, unlocked stops it`;
    - `every heartbeat proof goes to the helper`;
    - `enforcement is hard only when both helper and keyguard work`;
    - `keyguard exit while locked restarts it once per tick`.
  - `capabilities.test.ts`: `win32 with hardLock reports enforcement hard`, boshqa holatlarda `soft`.
  - `agent.test.ts`: `lock command triggers an immediate heartbeat`.
- [ ] **Step 2:** `pnpm vitest run --project companion` → FAIL.
- [ ] **Step 3:** Amalga oshiring.
  - `main.ts`: faqat `process.platform === 'win32'` da HelperClient (`\\.\pipe\netschool-helper`) va runner yaratiladi (`process.resourcesPath/keyguard/netschool-keyguard.exe`); boshqa OS'da `null`.
  - Helper xatosi overlay'ni to'xtatmaydi: soft overlay har doim ishlaydi.
- [ ] **Step 4:** `pnpm vitest run --project companion`, `pnpm -w typecheck`, `pnpm -w lint` → PASS.
- [ ] **Step 5:** Commit: `feat(companion): hard lock through the OS helper and keyboard guard`.

### Task 8: Enrollment, o'rnatish va paketlash

**Files:**
- Modify: `apps/companion/src/core/enroll.ts`, `apps/companion/src/cli/enroll.ts`, `apps/companion/scripts/pack-win.mjs`, `apps/companion/test/{enroll,pack-win}.test.ts`, `package.json` (root skript `build:os-helper`)

**Interfaces:**
- Consumes: Task 2 `overlayPublicKey`, Task 5 `helper.json` formati, Task 3–6 `dist/` exe'lari.
- Produces (zip tarkibi):
  - `resources/keyguard/netschool-keyguard.exe`;
  - `helper/netschool-helper.exe`;
  - `install-helper.cmd`, `remove-helper.cmd`;
  - `enroll.cmd` oldin `install-helper.cmd` ni chaqiradi.

`install-helper.cmd` (administrator) tartibi:
1. `sc stop NetSchoolHelper`, so'ng `%ProgramData%\NetSchool\helper` mavjud bo'lsa o'chiriladi. O'quvchi oldindan yaratgan papka qolmasin.
2. Papkani yaratish, so'ng `icacls … /setowner Administrators` va `icacls … /inheritance:r /grant:r SYSTEM:(OI)(CI)F Administrators:(OI)(CI)F Users:(OI)(CI)RX`.
3. `netschool-helper.exe` ni `%ProgramFiles%\NetSchool\helper\` ga nusxalash.
4. `sc create NetSchoolHelper binPath= "…" start= auto obj= LocalSystem`, `sc failure NetSchoolHelper reset= 60 actions= restart/1000/restart/1000/restart/1000`.

Keyin `enroll.mjs` `helper.json` ni yozadi, so'ng `sc start NetSchoolHelper`.

- [ ] **Step 1: Failing testlar.**
  - `enroll.test.ts`: `claim writes helper.json with deviceId and overlayPublicKey`. Yo'l parametr sifatida beriladi.
  - `pack-win.test.ts`:
    - `zip contains the helper, the keyguard and the install scripts`;
    - `install-helper resets the folder owner and ACL before the service starts` — `install-helper.cmd` matnida `/setowner` qatori `sc create` dan oldin;
    - `enroll.cmd runs install-helper first`;
    - `pack refuses when the os-helper binaries are missing`.
- [ ] **Step 2:** `pnpm vitest run --project companion enroll pack-win` → FAIL.
- [ ] **Step 3:** Amalga oshiring. `pack:win` `apps/os-helper/dist/windows-<arch>/` dan o'qiydi. Exe'lar yo'q bo'lsa xato beradi, eski binar jimgina olinmaydi.
- [ ] **Step 4:** Testlar PASS. Docker'da `pnpm build:os-helper && pnpm --filter @netschool/companion pack:win` → `~/Downloads/netschool-poc/` ga yangi zip.
- [ ] **Step 5:** Commit: `feat(companion): install the OS helper with enrollment`.

### Task 9: Hujjatlar va Windows'da qayta qochish testi

**Files:**
- Create: `docs/adr/0013-windows-hard-lock.md` — imzoli holat, fail-open lease, HKLM siyosatlari, keyguard, qolgan xavflar.
- Modify:
  - `docs/poc/capability-matrix.md` — Windows `classroom.overlay`: `hard` (sinalgan OS'larda);
  - `docs/poc/risks.md` — 7-band yangilanadi, yangi bandlar:
    - hub soati orqaga ketsa yangi holatlar lease tugaguncha rad etiladi;
    - ma'mur xizmatni to'xtata oladi;
    - Ctrl+Alt+Del ekranini (SAS) o'chirib bo'lmaydi, faqat bandlari olinadi;
  - `docs/poc/runbook-windows.md`;
  - `docs/poc/results/windows-x64-2026-11-0X-hard-lock.md`;
  - roadmap'dagi P0c qatori.

- [ ] **Step 1:** Egasi yangi zip bilan qayta o'rnatadi (`remove-autostart.cmd`, yangi `enroll.cmd`) va `sc query NetSchoolHelper` ni tekshiradi.
  Expected: `RUNNING`; panelda qurilma `enforcement: hard`.
- [ ] **Step 2:** Bloklangan holda qochish testi (kompyuterning o'z klaviaturasida): Win, Win+D, Win+L, Alt+Tab, Alt+F4, Ctrl+Esc, Ctrl+Shift+Esc, Ctrl+Alt+Del.
  Expected: hech biri overlay'dan o'tmaydi; Ctrl+Alt+Del ekranida faqat "Отмена".
- [ ] **Step 3:** Shu vaqtda o'qituvchi panelidan boshqarish.
  Expected: o'qituvchining klaviaturasi ishlaydi (inject qilingan).
- [ ] **Step 4:** Qaytish sinovlari:
  - ochish — siyosatlar ≤ 2 s ichida qaytadi;
  - hub `api` to'xtatiladi — ≤ 130 s ichida hammasi qaytadi;
  - bloklangan holda markaziy reboot — kirishdan keyin hub qayta bloklaydi, ochgach Vazifalar menejeri ishlaydi;
  - `sc stop` (administrator) — siyosatlar qaytadi.
- [ ] **Step 5:** Hujjatlarni natijalar bilan yozing. Sinalmagan OS'lar `not_tested`.
  Commit: `docs(poc): Windows hard lock results and ADR 0013`.

## Rejadan tashqarida (keyingi rejalar)

- Helper'ni hub'ga mustaqil ulash va qurilma kalitini helper'ga ko'chirish (P2d davomi).
- Imzolangan installer va avtoyangilash (P2e).
- AppLocker/WDAC va dastur o'rnatish taqiqi (P2h).
- macOS va Linux kuchli bloklash.
- Hub'dan WoL.
