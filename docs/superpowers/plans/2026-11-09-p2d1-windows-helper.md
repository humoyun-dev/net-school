# P2d1 — Windows OS Helper (SYSTEM xizmati) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Holat (2026-11-11):** Task 0–11 bajarildi. Task 12: Step 1 (hub darajasi, `classroom.sas_block`) va hujjatlar (ADR 0014, [qabul runbook'i](../../poc/results/windows-x64-2026-11-11-helper-manual.md), matrix, risklar, yo'l xaritasi) bajarildi; **Step 2 (qo'lda qabul sinovi) egasini kutmoqda**. Amalga oshirishdagi chetlanishlar [ADR 0014](../../adr/0014-windows-helper.md)'da va pastda tegishli joylarda belgilangan.

**Goal:** O'quvchi kompyuterida SYSTEM huquqli NetSchool Helper bloklashni o'quvchidan mustaqil ravishda majburlaydi: klaviatura, siyosat, yangi dasturlar, Ctrl+Alt+Del (Keyboard Filter bor joyda). Companion'ni ishga tushiradi va o'ldirilsa qayta ishga tushiradi, MeshAgent'ni kuzatadi. O'quvchi (standart foydalanuvchi) helper'ni to'xtata olmaydi.

**Architecture:** `native/helper` — bitta Go binary (`netschool-helper.exe`), uch rejim:
- `run`: Windows xizmati, session 0, SYSTEM.
- `guard`: o'quvchi sessiyasida SYSTEM tokeni bilan ishlaydigan oynasiz jarayon. Faqat klaviatura hook'i bor, shuning uchun o'quvchi uni yopa olmaydi.
- `install` / `uninstall`: admin.

Helper bloklash holatini Companion'dan emas, hub'dan **o'z kaliti bilan** oladi. Hub har qurilma uchun qat'iy o'suvchi imzo vaqtini talab qiladi, shuning uchun bir kalit ikki mijozga bo'linmaydi. Helper kaliti faqat SYSTEM/Administrators o'qiy oladigan faylda turadi. Companion UI (overlay) bo'lib qoladi va oddiy foydalanuvchi huquqida ishlaydi. Helper uni foydalanuvchi tokeni bilan ishga tushiradi va kuzatadi.

**Tech Stack:** Go (`go.mod`: `go 1.26.0`), faqat `golang.org/x/sys` (windows, svc, svc/mgr, registry). CGO yo'q. Hub tomoni: NestJS + Drizzle (migratsiya), zod contracts. Companion: mavjud TypeScript.

**Spec:** [ADR 0013](../../adr/0013-windows-hard-lock-results.md) (egasining talablari), [T6 natijasi](../../poc/results/windows-x64-2026-11-09-hard-lock-manual.md), arxitektura §6, §7.1, §12; yo'l xaritasi P2d qatori.

## Global Constraints

- Helper SYSTEM huquqida, xizmat nomi `NetSchoolHelper`, ko'rinadigan nomi `NetSchool Helper`, ishga tushish `Automatic`.
- Xizmat DACL (SDDL): `D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)`. Oddiy foydalanuvchi faqat holatni ko'radi, to'xtata/o'chira olmaydi.
- Xizmat qulasa qayta ishga tushadi: 1 s, 1 s, 5 s; hisoblagich 86400 s da nollanadi.
- O'rnatish joyi `%ProgramFiles%\NetSchool\` (`helper\netschool-helper.exe`, `companion\…`). Fayllarga faqat SYSTEM va Administrators yoza oladi. `C:\NetSchool` dan ishga tushirilmaydi: u yerga Authenticated Users yoza oladi, ya'ni SYSTEM'ga ko'tarilish xavfi bor.
- Helper ma'lumot katalogi `%ProgramData%\NetSchool\helper\`. ACL: faqat SYSTEM va Administrators (o'qish ham). U yerda `helper.key` (Ed25519 PKCS#8 PEM), `lock.json`, `policy-journal.json` turadi.
- Imzo formati Companion bilan bir xil: `NSDEV1\n{method}\n{pathWithQuery}\n{timestamp}\n{sha256hex(body)}`, Ed25519, base64url. Qo'shimcha sarlavha `x-ns-signer: helper`.
- Bloklash lease'i 120 s (hub `leaseSeconds`). Faqat teng yoki yangiroq `sequence` qo'llanadi. Saqlangan lock faqat shu boot ichida tiklanadi (Companion semantikasi, ADR 0009).
- Hub so'rovi har 5 s. TLS faqat hub CA (`hub-ca.pem`) yoki tizim root'lari bilan, hostname tekshiriladi. `InsecureSkipVerify` kodda umuman yo'q (testda tekshiriladi).
- Bloklash siyosati (`HKU\<SID>\Software\Microsoft\Windows\CurrentVersion\Policies`):
  - `System`: `DisableTaskMgr`, `DisableLockWorkstation`, `DisableChangePassword`;
  - `Explorer`: `NoLogoff`, `NoClose`;
  - va `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\HideFastUserSwitching`.
  Hammasi `REG_DWORD 1`, oldingi qiymat jurnalga yoziladi.
- Shell yoki ixtiyoriy buyruq bajarish yo'q. Tashqi jarayon faqat qat'iy argumentlar bilan (`powershell.exe` Keyboard Filter uchun, `icacls.exe`).
- Hamma Windows'ga xos kod `//go:build windows` faylida. Toza mantiq har OS'da test qilinadi.
- Hujjatlar va izohlar o'zbekcha, commit xabarlari inglizcha (`feat(helper): …`).

## Review Focus

1. **O'quvchi Companion'ni ketma-ket o'ldiradi.** Har safar ≤ 3 s ichida qayta ishga tushishi, lekin crash-loop'da CPU'ni yemasligi kerak (backoff 1 s → 30 s faqat jarayon 5 s dan kam yashasa — `StartupCrashWindow`; aks holda 1 s dan keyin qayta. Rejadagi "60 s" 5 s ga o'zgardi, ADR 0014). Test: Task 6 `TestSupervisorBacksOffOnCrashLoop`.
2. **Bloklash paytida hub yo'qoladi.** Lease (120 s) tugashi bilan helper hook, siyosat va process guard'ni bo'shatishi kerak. O'quvchi abadiy bloklanib qolmasin. Test: Task 3 `TestLeaseExpiresWithoutHub`, Task 10 `TestHubLossReleasesAfterLease`.
3. **Helper bloklash paytida qulaydi yoki kompyuter o'chadi.** Keyingi ishga tushishda bloklash yo'q bo'lsa siyosat jurnal bo'yicha qaytariladi va Keyboard Filter o'chiriladi. Test: Task 4 `TestStartRestoresLeftoverPolicy`, Task 9 `TestStartDisablesLeftoverFilter`.
4. **Sessiya almashadi:** logoff, boshqa foydalanuvchi kiradi yoki ekran qulflanadi. Siyosat yangi foydalanuvchiga ko'chishi, eski foydalanuvchi hive'idan qaytarilishi kerak. Test: Task 4 `TestPolicyFollowsSessionUser`.
5. **Process guard o'quvchining ochiq ishini o'ldirmasligi kerak.** Bloklashdan oldin ochilgan dasturlar va ularning bolalari (masalan brauzer tablari) yashaydi. Baseline'da bo'lmagan jarayon faqat bir xil exe avlodi bo'lsa yashaydi; taskmgr, explorer orqali ochilgan va yangi ildizdan boshlangan jarayonlar o'ldiriladi (ADR 0014). Test: Task 8 `TestBaselineDescendantsSurvive`.

---

## File Structure

```
native/helper/
  go.mod, go.sum
  cmd/netschool-helper/main.go         # subbuyruqlar: run | guard | install | uninstall | version
  internal/hub/signer.go               # NSDEV1 imzo, monoton timestamp, soat offset
  internal/hub/client.go               # LockState, ReportStatus (TLS: faqat hub CA)
  internal/lock/lock.go                # lease + sequence holat mashinasi (toza)
  internal/lock/store.go               # lock.json (shu boot ichida tiklash)
  internal/keys/policy.go              # KeyPolicy Go porti (toza)
  internal/policy/journal.go           # jurnal mantiq (toza, Registry interfeysi)
  internal/policy/registry_windows.go  # HKU\<SID> va HKLM yozish
  internal/session/session_windows.go  # faol konsol sessiyasi, user token/SID, CreateProcessAsUser
  internal/supervise/supervisor.go     # bola jarayon kuzatuvchi, backoff (toza)
  internal/guard/pipe_windows.go       # service → guard named pipe (SYSTEM-only SDDL)
  internal/guard/hook_windows.go       # guard rejimi: WH_KEYBOARD_LL + GetMessageW
  internal/procguard/decide.go         # o'ldirish qarori (toza)
  internal/procguard/scan_windows.go   # snapshot, sessiya, terminate
  internal/cad/cad.go                  # Backend interfeysi + holatlar
  internal/cad/kbfilter_windows.go     # Keyboard Filter (WEKF_PredefinedKey) powershell orqali
  internal/meshwatch/meshwatch_windows.go
  internal/service/service.go          # orkestr (toza, portlar orqali)
  internal/service/run_windows.go      # svc.Handler, sessiya hodisalari
  internal/install/install_windows.go  # nusxa, ACL, xizmat yaratish, SDDL, recovery
packages/contracts/fixtures/device-signature.json   # TS ↔ Go imzo vektorlari
packages/contracts/fixtures/key-policy.json         # TS ↔ Go tugma qoidalari vektorlari
packages/contracts/src/api/v1/helper.ts             # lockState, helperStatus schema
apps/api/drizzle/0013_device_helper.sql
apps/api/src/modules/devices/helper.controller.ts
apps/companion/src/cli/enroll.ts                    # helper kalitini ham yaratadi
apps/companion/scripts/pack-win.mjs                 # helper.exe, install.cmd, uninstall.cmd
```

---

### Task 0: Go moduli, CI va build

**Files:**
- Create: `native/helper/go.mod`, `native/helper/cmd/netschool-helper/main.go`, `native/helper/internal/version/version.go`
- Modify: `.github/workflows/ci.yml`, `package.json` (scripts), `biome.json` (agar kerak bo'lsa `native/` istisno)
- Test: `native/helper/cmd/netschool-helper/main_test.go`

**Interfaces:**
- Produces: `pnpm build:helper` → `native/helper/dist/netschool-helper-windows-<arch>.exe` (`GOOS=windows`, `CGO_ENABLED=0`, `-trimpath`, `-ldflags "-s -w -X …/version.Version=<git describe>"`), arch `amd64` va `arm64`. `pnpm test:helper` → `go test ./...` va `go vet ./...` (`native/helper` ichida).

- [ ] **Step 1:** Mac'da Go o'rnatish: `brew install go`. Natija `go version` ≥ 1.26.
- [ ] **Step 2:** `main_test.go`: `TestUnknownSubcommandExits2` — `run([]string{"nope"}, &stderr)` 2 qaytaradi, stderr'da `usage:`. `TestVersionPrints` — `version` 0 qaytaradi va `version.Version`ni chiqaradi.
- [ ] **Step 3:** FAIL → `func run(args []string, stdout, stderr io.Writer) int` va subbuyruqlar jadvali (hozircha `version`; qolganlari keyingi vazifalarda ulanadi) → PASS.
- [ ] **Step 4:** CI: yangi `helper` job: ubuntu'da `actions/setup-go` (`go-version-file: native/helper/go.mod`), `go vet ./...`, `go test ./...`, ikki arch uchun cross-build. Yangi `helper-windows` job: `windows-latest`'da `go test ./...` (Windows build-tag'li testlar shu yerda ishlaydi).
- [ ] **Step 5:** `pnpm build:helper && ls native/helper/dist`: ikki `.exe` bor. Commit: `feat(helper): Go module, CLI skeleton and CI`.

### Task 1: Imzo vektorlari va Go imzolovchi

**Files:**
- Create: `packages/contracts/fixtures/device-signature.json`, `apps/companion/test/signature-fixture.test.ts`, `native/helper/internal/hub/signer.go`, `signer_test.go`

**Interfaces:**
- Produces (Go): `type Signer struct`; `func NewSigner(deviceID string, key ed25519.PrivateKey, signer string, now func() time.Time) *Signer`; `func (s *Signer) Sign(method, pathWithQuery string, body []byte) http.Header` (`x-ns-device-id`, `x-ns-timestamp`, `x-ns-signature`, `x-ns-signer`); `func (s *Signer) SyncClock(hubTime time.Time)` (farq > 5 s bo'lsa offset, aks holda 0, oxirgi timestamp tortiladi — `identity.ts` `syncClock` bilan bir xil); `func LoadKey(pemPath string) (ed25519.PrivateKey, error)`.

- [ ] **Step 1:** Fixture: 3 vektor (`GET` bo'sh tana, `PUT` JSON tana, query bilan yo'l). Har birida `privateKeyPem`, `deviceId`, `method`, `pathWithQuery`, `timestamp`, `bodyBase64`, `expectedSignature`. Fixture'ni TS yaratadi: `signature-fixture.test.ts` fayldagi har vektorni `identity.ts` bilan qayta hisoblab tenglikni tekshiradi (vektorlar o'zgarsa test yiqiladi).
- [ ] **Step 2:** `TestSignatureMatchesFixtures` (Go): fixture'ni o'qiydi (`../../../../packages/contracts/fixtures/device-signature.json`), qat'iy `now` bilan imzolaydi va `expectedSignature`ga teng. `TestTimestampStrictlyIncreases`: bir xil `now` bilan ikki `Sign` → ikkinchi timestamp = birinchi + 1. `TestSyncClockFixesOffsetAndPullsLastTimestamp`.
- [ ] **Step 3:** FAIL → implementatsiya → PASS (`go test ./internal/hub/`, `pnpm vitest run --project unit apps/companion/test/signature-fixture.test.ts`).
- [ ] **Step 4:** Commit: `feat(helper): device request signer shared with Companion through fixtures`.

### Task 2: Hub — helper kaliti va bloklash holati endpoint'i

**Files:**
- Create: `apps/api/drizzle/0013_device_helper.sql` (drizzle-kit generate), `packages/contracts/src/api/v1/helper.ts`, `apps/api/src/modules/devices/helper.controller.ts`, `apps/api/test/device-helper.test.ts`
- Modify: `apps/api/src/db/schema.ts` (`devices.helperPublicKey text null`, `devices.helperLastSignedTs bigint null`), `device-verifier.ts`, `device-auth.guard.ts`, `enrollments.service.ts`, `packages/contracts/src/api/v1/devices.ts` (`claimRequestSchema`ga ixtiyoriy `helperPublicKey`, `helperProof`), `apps/api/test/support/db.ts` (TABLES o'zgarmaydi, ustunlar qo'shiladi)

**Interfaces:**
- Produces (contracts): `helperLockStateSchema = { locked: boolean, sequence: string | null, leaseSeconds: number }`; `helperStatusSchema = { version: string, hook: Component, policy: Component, processGuard: Component, cad: 'blocked' | 'unavailable' | 'failed' | 'off', companion: 'running' | 'restarting' | 'no_session', meshAgent: 'running' | 'restarted' | 'stopped' }`, `Component = 'active' | 'off' | 'failed'`.
- Produces (HTTP): `GET /api/v1/device/helper/lock-state` → `helperLockStateSchema` (dars yo'q → `{locked:false, sequence:null, leaseSeconds:120}`; holat yaratmaydi, heartbeat emas). `PUT /api/v1/device/helper/status` → 204.
- `DeviceVerifier.verify(…, signer: 'companion' | 'helper')`: `x-ns-signer: helper` bo'lsa `helperPublicKey` va `helperLastSignedTs` ishlatiladi. Companion yo'llari helper imzosini rad etadi va aksincha (bir xil `unauthenticated`).
- Claim: `helperProof` = `NSCLAIM1\n{token}\n{helperPublicKey}` helper kaliti bilan. Ikkalasi birga yoki hech biri, aks holda 400.

- [ ] **Step 1:** Testlar (`device-helper.test.ts`, mavjud `test/support` bilan):
  - `helper key signs only helper routes`: helper imzosi bilan `POST /device/heartbeat` → 401; Companion imzosi bilan `GET /device/helper/lock-state` → 401.
  - `companion and helper timestamps do not collide`: Companion ts=1000, keyin helper ts=900 → ikkalasi 200 (alohida hisoblagich).
  - `lock-state mirrors the active lesson overlay`: lock buyrug'idan keyin `{locked:true, sequence:"<seq>", leaseSeconds:120}`; dars tugagach `locked:false`.
  - `lock-state has no presence side effect`: so'rovdan keyin `lastHeartbeatAt` o'zgarmaydi.
  - `claim stores the helper key only with a valid proof`: noto'g'ri proof → 400 va qurilma yaratilmaydi.
- [ ] **Step 2:** `pnpm vitest run --project unit apps/api/test/device-helper.test.ts` → FAIL.
- [ ] **Step 3:** Schema → `cd apps/api && pnpm exec drizzle-kit generate` → `0013_device_helper.sql`. Verifier/guard/controller/claim implementatsiyasi. Lock-state `presence.service.ts`dagi dars so'rovini qayta ishlatadi (yangi funksiya `lockStateOf(device)`, heartbeat ham undan foydalanadi).
- [ ] **Step 4:** PASS, keyin `pnpm test`, `pnpm typecheck`, `pnpm lint`. Commit: `feat(api): helper key and lock state for the OS helper`.

### Task 3: Bloklash holat mashinasi va hub mijozi (Go)

**Files:**
- Create: `native/helper/internal/lock/lock.go`, `store.go`, `lock_test.go`, `native/helper/internal/hub/client.go`, `client_test.go`

**Interfaces:**
- Produces: `type Clock interface { Now() time.Time; Uptime() time.Duration; BootID() string }`; `type Lock struct`; `func New(clock Clock, store Store) *Lock`; `func (l *Lock) Apply(s hub.LockState)` (sequence `uint64`ga parse; kichigi e'tiborsiz; `locked` bo'lsa deadline = uptime + lease); `func (l *Lock) Tick()` (uptime ≥ deadline → unlocked); `func (l *Lock) Locked() bool`; `func (l *Lock) Restore()` (store'dan, faqat bir xil `BootID` va deadline o'tmagan bo'lsa).
- Produces: `type LockState struct { Locked bool; Sequence *string; LeaseSeconds int }`; `func NewClient(origin string, caPEM []byte, signer *Signer) (*Client, error)`; `func (c *Client) LockState(ctx) (LockState, error)`; `func (c *Client) ReportStatus(ctx, Status) error`. 401 bo'lsa javob `Date` bilan `SyncClock` va bir marta qayta urinish.

- [ ] **Step 1:** Testlar: `TestLockAppliesOnlyNewerSequence`, `TestLeaseExpiresWithoutHub` (Apply locked, uptime +121 s, Tick → unlocked), `TestRestoreOnlyWithinSameBoot`, `TestUnlockClearsStore`. Mijoz: `httptest.NewTLSServer` bilan `TestClientTrustsOnlyHubCA` (boshqa CA → xato), `TestClientRetriesOnceAfterClockSync`, `TestNoInsecureSkipVerifyInSource` (paket fayllarida `InsecureSkipVerify` satri yo'q).
- [ ] **Step 2:** FAIL → implementatsiya → PASS (`go test ./internal/lock/ ./internal/hub/`).
- [ ] **Step 3:** Commit: `feat(helper): lock lease state and hub client`.

### Task 4: Bloklash siyosati (HKU\<SID>) va jurnal

**Files:**
- Create: `native/helper/internal/policy/journal.go`, `journal_test.go`, `registry_windows.go`, `registry_windows_test.go`

**Interfaces:**
- Produces: `type Registry interface { Read(root, key, name string) (*uint32, error); Write(root, key, name string, v uint32) error; Delete(root, key, name string) error }`; `type Policy struct`; `func NewPolicy(reg Registry, journalPath string) *Policy`; `func (p *Policy) Apply(userSID string) error`; `func (p *Policy) Restore() error`; `func (p *Policy) Pending() bool`. Jurnal har yozuv uchun `{root, key, name, previous *uint32, sid}` saqlaydi. Avval jurnal, keyin qiymatlar. `Restore` muvaffaqiyatsiz yozuvlarni jurnalda qoldiradi.
- `root`: `HKU\<SID>` yoki `HKLM`. Qiymatlar ro'yxati Global Constraints'da.

- [ ] **Step 1:** Toza testlar (soxta Registry): `TestApplyJournalsBeforeWriting`, `TestRestoreReturnsPreviousValues`, `TestApplyTwiceKeepsOriginalPrevious`, `TestStartRestoresLeftoverPolicy`, `TestPolicyFollowsSessionUser` (Apply(sidA) → Apply(sidB) avval sidA'ni tiklaydi, keyin sidB'ga yozadi), `TestPartialRestoreKeepsFailedEntries`.
- [ ] **Step 2:** Windows testi (`windows-latest`, admin runner): `TestRegistryRoundTripUnderTestKey`: `HKCU\Software\NetSchoolTest`da yozish/o'qish/o'chirish (haqiqiy `Policies`ga tegmaydi).
- [ ] **Step 3:** FAIL → implementatsiya (`golang.org/x/sys/windows/registry`, `HKU` uchun `registry.USERS` + `<SID>\…`) → PASS.
- [ ] **Step 4:** Commit: `feat(helper): lock policy in the session user's hive with a restore journal`.

### Task 5: KeyPolicy porti va TS ↔ Go vektorlari

**Files:**
- Create: `packages/contracts/fixtures/key-policy.json`, `native/helper/internal/keys/policy.go`, `policy_test.go`
- Modify: `apps/companion/test/key-policy.test.ts` (fixture'ni ham o'tkazadi)

**Interfaces:**
- Produces: `type Event struct { VK uint32; Flags uint32; Down bool }`; `type Policy struct`; `func (p *Policy) Handle(e Event) (block bool)`; `func (p *Policy) Reset()`. Qoidalar `apps/companion/src/core/key-policy.ts` bilan bir xil (Win, Alt+Tab/Esc/F4/Space, Ctrl+Esc, to'silgan tugmaning "up"i). Amalga oshirishda: injected tugma faqat `LLKHF_LOWER_IL_INJECTED` bitisiz bo'lsa o'tadi (MeshAgent/SYSTEM kiritishi o'tadi, o'quvchining `SendInput`i to'siladi; rejadagi "`LLKHF_INJECTED` o'tadi" o'zgardi, ADR 0014).

- [ ] **Step 1:** Fixture: hodisalar ketma-ketliklari va kutilgan `block[]` (mavjud `key-policy.test.ts` holatlaridan, kamida 8 ta ketma-ketlik). TS testi fixture'ni o'tkazadi.
- [ ] **Step 2:** `TestFixtureSequences` (Go) → FAIL → port → PASS.
- [ ] **Step 3:** Commit: `feat(helper): key block rules in Go, pinned to Companion by fixtures`.

### Task 6: Sessiya, jarayon ishga tushirish va kuzatuvchi

**Files:**
- Create: `native/helper/internal/supervise/supervisor.go`, `supervisor_test.go`, `native/helper/internal/session/session_windows.go`, `session_windows_test.go`

**Interfaces:**
- Produces (toza): `type Launcher interface { Start() (Proc, error) }`; `type Proc interface { Wait() error; Kill() error }`; `type Clock interface { Now() time.Time; Sleep(ctx context.Context, d time.Duration) error }` (`lock.Clock`dan alohida); `type Supervisor struct`; `func NewSupervisor(name string, l Launcher, clock Clock) *Supervisor`; `func (s *Supervisor) Run(ctx)` (backoff: 1 s, 2 s, 4 s … 30 s faqat jarayon `StartupCrashWindow` = 5 s dan kam yashasa; aks holda 1 s dan keyin qayta. Rejadagi "≥ 60 s" 5 s ga o'zgardi, ADR 0014); `func (s *Supervisor) State() string` (`running` | `restarting` | `stopped`).
- Produces (Windows): `type Session struct { ID uint32; UserSID string }`; `func ActiveConsole() (Session, bool, error)` (`WTSGetActiveConsoleSessionId`, foydalanuvchi yo'q → `false`); `func StartAsUser(s Session, exe string, args []string) (Proc, error)` (`WTSQueryUserToken` + `CreateProcessAsUser`, `winsta0\default`, environment `CreateEnvironmentBlock`); `func StartAsSystemInSession(s Session, exe string, args []string) (Proc, error)` (o'z tokenini `DuplicateTokenEx`, `SetTokenInformation(TokenSessionId)`, `CreateProcessAsUser`).

- [ ] **Step 1:** Toza testlar (soxta Launcher/Clock): `TestSupervisorRestartsAfterExit`, `TestSupervisorBacksOffOnCrashLoop` (5 tez yiqilish → kutish 1,2,4,8,16 s), `TestSupervisorResetsBackoffAfterStableRun`, `TestSupervisorStopsOnCancel` (bola o'ldiriladi).
- [ ] **Step 2:** Windows testi: `TestActiveConsoleOnRunner` faqat `ID` qaytishini tekshiradi (runner'da foydalanuvchi bo'lmasligi mumkin → `false` ham qabul).
- [ ] **Step 3:** FAIL → implementatsiya → PASS.
- [ ] **Step 4:** Commit: `feat(helper): session processes and a supervisor with backoff`.

### Task 7: Guard jarayoni (SYSTEM, o'quvchi sessiyasida) va pipe

**Files:**
- Create: `native/helper/internal/guard/pipe_windows.go`, `hook_windows.go`, `guard_test.go` (toza protokol), `pipe_windows_test.go`
- Modify: `cmd/netschool-helper/main.go` (`guard` subbuyrug'i)

**Interfaces:**
- Produces: pipe nomi `\\.\pipe\netschool-helper-guard`, SDDL `D:P(A;;GA;;;SY)` (faqat SYSTEM). Protokol: qator bilan ajratilgan JSON. Service → guard `{"locked":true|false}` (har o'zgarishda va har 5 s). Guard → service `{"hook":"active"|"off"|"failed"}`.
- Guard: `runtime.LockOSThread`, `SetWindowsHookExW(WH_KEYBOARD_LL)` `windows.NewCallback` bilan, `GetMessageW` sikli. Callback faqat `keys.Policy.Handle`. Hook faqat `locked:true` paytida o'rnatiladi. Pipe uzilsa guard hook'ni olib, 1 s dan keyin qayta ulanadi. Service guard'ni Task 6 `StartAsSystemInSession` + Supervisor bilan ushlaydi.

- [ ] **Step 1:** Toza testlar: `TestProtocolRoundTrip`, `TestGuardDropsHookWhenPipeCloses` (soxta hook va soxta ulanish bilan holat mashinasi).
- [ ] **Step 2:** Windows testi: `TestPipeRejectsNonSystemClient`: runner admin'i SYSTEM emas, ulanish `ERROR_ACCESS_DENIED`.
- [ ] **Step 3:** FAIL → implementatsiya → PASS.
- [ ] **Step 4:** Commit: `feat(helper): SYSTEM keyboard guard in the student session`.

### Task 8: Bloklash paytida yangi dasturlarni to'xtatish (process guard)

**Files:**
- Create: `native/helper/internal/procguard/decide.go`, `decide_test.go`, `scan_windows.go`

**Interfaces:**
- Produces (toza): `type Proc struct { PID, ParentPID, Session uint32; Image string; Created time.Time }` (`Image` to'liq yo'l, kichik harf; `Created` — `GetProcessTimes`); `type Allow struct { Dirs []string; Images []string }`; `func Decide(p Proc, session uint32, baseline map[uint32]bool, procs map[uint32]Proc, allow Allow) bool` (true = o'ldirish).
- Qoida (amalga oshirishda o'zgardi, yakuniy shakli ADR 0014'da): baseline'da bo'lmagan jarayon faqat **bir xil exe avlodi** bo'lsa yashaydi (ota zanjiri tirik baseline ajdodga yetadi va zanjirdagi hamma jarayon aynan shu exe); `System32\taskmgr.exe` baseline'da bo'lsa ham o'ldiriladi; ota PID'i eskirgan jarayon bir skan o'tkazib yuboriladi. Quyidagi dastlabki qoida tarix uchun qoldirildi:
  - boshqa sessiya → yo'q;
  - `allow.Dirs` (`%ProgramFiles%\NetSchool\`, `%ProgramFiles%\Mesh Agent\`) yoki `allow.Images` (`%SystemRoot%\System32\` ichidagi `conhost.exe`, `dwm.exe`, `csrss.exe`, `fontdrvhost.exe`, `ctfmon.exe`, `LogonUI.exe`, `consent.exe`, `WerFault.exe`, `SystemSettingsBroker.exe`; `TextInputHost.exe` o'z yo'li bilan) → yo'q;
  - baseline'dagi jarayonning avlodi → yo'q. Istisno: zanjirda `explorer.exe`, `taskmgr.exe`, `sihost.exe`, `RuntimeBroker.exe` dan keyin kelgan bo'lsa, ota-onasi baseline bo'lsa ham → ha;
  - qolgani → ha.
- Windows: har 250 ms `CreateToolhelp32Snapshot`, `ProcessIdToSessionId`, `QueryFullProcessImageNameW`, `TerminateProcess`. Baseline — bloklash boshlangan paytdagi sessiya jarayonlari. Faqat bloklash paytida ishlaydi.

- [ ] **Step 1:** Testlar: `TestBaselineDescendantsSurvive` (chrome → renderer), `TestTaskManagerIsKilled`, `TestChildOfExplorerIsKilled`, `TestNetSchoolAndMeshAgentAllowed`, `TestOtherSessionIgnored`, `TestPidReuseNotTrusted` (ota PID baseline'da, lekin ota jarayonning `Created` vaqti bolanikidan keyin → ota hisoblanmaydi).
- [ ] **Step 2:** FAIL → implementatsiya → PASS.
- [ ] **Step 3:** Commit: `feat(helper): stop programs started in the student session during a lock`.

### Task 9: Ctrl+Alt+Del (Keyboard Filter backend)

**Files:**
- Create: `native/helper/internal/cad/cad.go`, `cad_test.go`, `kbfilter_windows.go`

**Interfaces:**
- Produces: `type Backend interface { Available() (bool, string); Block(ctx) error; Unblock(ctx) error }`; `type Guard struct`; `func NewGuard(b Backend, journalPath string) *Guard`; `func (g *Guard) Set(ctx, locked bool) (state string)` (`blocked` | `unavailable` | `failed` | `off`); `func (g *Guard) Start(ctx)` (jurnalda "blocked" qolgan bo'lsa → `Unblock`).
- `kbfilter_windows.go`: `Available` — `Get-WindowsOptionalFeature -Online -FeatureName Client-KeyboardFilter` yoqilgan va `MsKeyboardFilter` xizmati bor. `Block`/`Unblock`: `root\standardcimv2\embedded` `WEKF_PredefinedKey` `Id='Ctrl+Alt+Del'` va `Id='Win+L'`ni `Enabled=$true/$false`. Hammasi `powershell.exe -NoProfile -NonInteractive -Command <qat'iy skript>`, skriptda tashqi matn yo'q.
- Pro/Home'da `unavailable`, sabab `edition`. **To'liq to'sish bu nashrlarda bu rejaga kirmaydi** (pastdagi Ochiq qaror).

- [ ] **Step 1:** Testlar (soxta Backend): `TestUnavailableBackendReportsEdition`, `TestBlockThenUnblock`, `TestStartDisablesLeftoverFilter`, `TestBlockFailureReportsFailed`.
- [ ] **Step 2:** FAIL → implementatsiya → PASS.
- [ ] **Step 3:** Commit: `feat(helper): block Ctrl+Alt+Del through Keyboard Filter where Windows has it`.

### Task 10: MeshAgent kuzatuvchi va xizmat orkestri

**Files:**
- Create: `native/helper/internal/meshwatch/meshwatch_windows.go`, `native/helper/internal/service/service.go`, `service_test.go`, `run_windows.go`
- Modify: `cmd/netschool-helper/main.go` (`run`)

**Interfaces:**
- Produces: `meshwatch.Check() (state string, err error)` (har 15 s; `Mesh Agent` to'xtagan bo'lsa `Start`, holat `restarted`).
- `service.Deps` portlari: `Hub` (Task 3), `Lock`, `Policy` (Task 4), `Guard` (Task 7, pipe orqali), `ProcGuard` (Task 8), `CAD` (Task 9), `Companion` va `GuardProc` Supervisor'lari (Task 6), `Mesh`, `Sessions`. `func (s *Service) Step(ctx)` har 1 s chaqiriladi va:
  - 5 s da bir marta `Hub.LockState` → `Lock.Apply`, so'ng `Lock.Tick`;
  - `locked` o'zgarsa: Policy.Apply(SID)/Restore, Guard'ga holat, ProcGuard yoqish/o'chirish (baseline olish), CAD.Set;
  - bloklash paytida har 10 s siyosatni qayta qo'llaydi (drift);
  - 30 s da bir marta yoki komponent holati o'zgarganda `Hub.ReportStatus`.
- `run_windows.go`: `svc.Handler`, `SessionChange` hodisalari (logon/logoff/console connect) Supervisor'larni yangi sessiyaga ko'chiradi. Ishga tushishda `Policy.Restore` (bloklash yo'q bo'lsa), `CAD.Start`.

- [ ] **Step 1:** Toza testlar (hamma portlar soxta): `TestLockEngagesAllComponents`, `TestUnlockReleasesAllComponents`, `TestHubLossReleasesAfterLease`, `TestDriftIsReapplied`, `TestSessionChangeMovesPolicy`, `TestStatusReportedOnChange`.
- [ ] **Step 2:** FAIL → implementatsiya → PASS.
- [ ] **Step 3:** Commit: `feat(helper): service loop that enforces the lock and watches MeshAgent`.

### Task 11: O'rnatish, himoya va paket

**Files:**
- Create: `native/helper/internal/install/install_windows.go`, `install_test.go` (toza: SDDL va yo'llar)
- Modify: `cmd/netschool-helper/main.go` (`install`, `uninstall`), `apps/companion/src/cli/enroll.ts` (amalga oshirishda: helper kalitini `netschool-helper helper-key`dan oladi va o'zi yozmaydi, claim'ga `helperPublicKey/helperProof`, claim'dan keyin `set-hub`; token va CA stdin orqali), `apps/companion/test/enroll.test.ts`, `apps/companion/scripts/pack-win.mjs` + `pack-win.test.ts`, `pack-win.d.mts`

**Interfaces:**
- `netschool-helper.exe install --companion-dir <yo'yilgan zip>`: admin talab qiladi (aks holda chiqish kodi 5). Bajaradi:
  1. `%ProgramFiles%\NetSchool\{helper,companion}`ga nusxa;
  2. `icacls` bilan `%ProgramFiles%\NetSchool` va `%ProgramData%\NetSchool\helper` ACL'i (Global Constraints);
  3. ~~`enroll` yozgan `helper.key`ni `%ProgramData%\NetSchool\helper`ga ko'chirish~~ — amalga oshirishda: `enroll` helper kalitini o'zi yozmaydi; `netschool-helper helper-key` uni helper katalogida yaratadi (token stdin orqali), claim'dan keyin `netschool-helper set-hub` hub manzili va CA'ni oladi (CA stdin orqali), so'ng `install` (ADR 0014);
  4. xizmat yaratish, SDDL, recovery;
  5. eski HKLM Run `NetSchool Companion` qiymatini o'chirish;
  6. xizmatni ishga tushirish.
- `uninstall`: admin; xizmatni to'xtatib o'chiradi, siyosat va CAD qaytariladi (xizmat `stop`da `Restore` qiladi), fayllar o'chiriladi.
- `pack-win`: zip'ga `netschool-helper.exe` (arch'ga mos, `native/helper/dist`dan; yo'q bo'lsa yig'ilmaydi). `enroll.cmd` endi: enroll (ichida `helper-key` va `set-hub`) → `netschool-helper.exe install --companion-dir "%~dp0."`. `remove-autostart.cmd` o'rniga `uninstall.cmd`.

- [ ] **Step 1:** Testlar: `TestServiceSDDLDeniesStopToUsers` (SDDL satrida `IU`/`SU` uchun `RP`, `WP`, `DT`, `SD` yo'q), `TestInstallPathsAreUnderProgramFiles`; `enroll.test.ts`: `enroll writes a helper key and sends its proof`; `pack-win.test.ts`: `the package carries the helper and refuses to build without it`, `enroll.cmd installs the helper after a successful enroll`.
- [ ] **Step 2:** FAIL → implementatsiya → PASS (`pnpm test`, `pnpm test:helper`).
- [ ] **Step 3:** Commit: `feat(helper): install as a protected service; Windows package ships the helper`.

### Task 12: Panelda haqiqiy daraja va qo'lda qabul sinovi

**Files:**
- Modify: `apps/api/src/modules/devices/presence.service.ts` (yoki capability yig'uvchi joy), `apps/api/test/device-helper.test.ts`, `apps/web` (agar overlay darajasi ko'rsatilsa, matn)
- Create: `docs/poc/results/windows-x64-<sana>-helper-manual.md`, `docs/adr/0014-windows-helper.md`
- Modify: `docs/poc/capability-matrix.md`, `docs/poc/risks.md` (#4, #12, #16, #17), yo'l xaritasi P2d qatori, bu reja holati

**Interfaces:**
- Hub `classroom.overlay`ni helper holatidan hisoblaydi:
  - oxirgi helper statusi ≤ 90 s bo'lsa: `hard` faqat `hook=active`, `policy=active`, `processGuard=active` bo'lganda, aks holda `soft` + birinchi yiqilgan komponent nomi (`hook_failed` | `policy_failed` | `process_guard_failed`);
  - helper statusi bo'lmasa yoki eski bo'lsa: Companion hisoboti, lekin `hard` hech qachon emas (`reason: helper_missing`).
- Yangi capability `classroom.sas_block`: `cad=blocked|off` → `available`, `unavailable` → `unsupported` (`reason: edition`), `failed` → `unsupported` (`reason: failed`).

- [x] **Step 1:** API testlari: `overlay is hard only when the helper reports every component active`, `a stale helper status falls back to soft`, `sas_block reports the edition limit`. FAIL → implementatsiya → PASS.
- [ ] **Step 2 (egasini kutmoqda; batafsil ro'yxat [runbook](../../poc/results/windows-x64-2026-11-11-helper-manual.md)da):** Windows x64'da qo'lda sinov, **standart (admin emas) o'quvchi hisobida**:
  1. o'rnatish (`enroll.cmd`);
  2. o'quvchi `sc stop NetSchoolHelper` → «Отказано в доступе»;
  3. Vazifalar menejeri helper/guard'ni yopa olmaydi;
  4. Companion'ni o'ldirish → ≤ 3 s da qaytadi;
  5. bloklash: Win, Alt+Tab, Ctrl+Esc, Ctrl+Shift+Esc, Alt+F4 to'siladi; Ctrl+Alt+Del ekranida Vazifalar menejeri, Qulflash, Chiqish, Parol, quvvat yo'q;
  6. bloklashdan oldin ochilgan brauzer yashaydi, yangi dastur ochilmaydi;
  7. masofaviy boshqaruv ishlaydi;
  8. ochish: hammasi qaytadi;
  9. hub o'chsa ~120 s da qaytadi (vaqtni telefon soati bilan);
  10. bloklangan holda helper xizmati majburan o'ldirilsa (admin) → qayta ishga tushadi, siyosat to'g'ri;
  11. reboot;
  12. MeshAgent `sc stop` (admin) → ≤ 15 s da qaytadi;
  13. `uninstall.cmd` → hamma narsa toza.
- [ ] **Step 3:** (ADR 0014, runbook, matrix, risks va yo'l xaritasi Step 2'dan oldin yozildi, commit `docs(poc): Windows helper ADR 0014 and acceptance runbook`; sinovdan keyin natija bilan qayta yangilanadi.) Natija, ADR 0014, matrix, risks, yo'l xaritasi yangilanadi. Commit: `docs(poc): Windows helper acceptance results and ADR 0014`.

---

## Ochiq qaror (egasi)

**Windows Pro/Home'da Ctrl+Alt+Del'ni to'liq to'sish.** Bu rejadan keyin Pro/Home'da Ctrl+Alt+Del ekrani ochiladi, lekin unda faqat «Отмена» qoladi va dastur ochib bo'lmaydi (Task 4, 8). Talab "umuman ishlamasin" bo'lgani uchun ikki yo'l bor:
- **(a)** laboratoriyalarni Windows **Education**'ga o'tkazish (kalit almashtirish, qayta o'rnatishsiz). Bu reja Task 9 bilan darhol ishlaydi.
- **(b)** Microsoft attestatsiya imzosi bilan kernel klaviatura filtr drayveri (EV sertifikat kerak). Alohida reja `P2d2` va `cad.Backend`ning ikkinchi amalga oshirilishi.

## Bu rejaga kirmaydi

Companion ↔ helper buyruq kanali va Companion kalitini helper'ga ko'chirish; P2g (dastur o'rnatish) va P2h (doimiy bazaviy siyosat, standart foydalanuvchi yaratish); imzolangan MSI va avtoyangilash (P2e); macOS va Linux helper'lari; kernel drayver.
