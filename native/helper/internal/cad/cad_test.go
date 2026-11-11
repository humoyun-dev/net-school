package cad

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

var errBoom = errors.New("powershell yiqildi")

// fakeBackend Backend'ning xotiradagi nusxasi: chaqiruvlarni ketma-ketlikda yozib boradi.
type fakeBackend struct {
	available bool
	reason    string

	blockErr   error
	unblockErr error

	calls []string
	// onBlock Block chaqirilganda (xato qaytarishdan oldin) ishlaydi: jurnal tartibini tekshirish uchun.
	onBlock func()
}

func (f *fakeBackend) Available() (bool, string) {
	f.calls = append(f.calls, "available")
	return f.available, f.reason
}

func (f *fakeBackend) Block(context.Context) error {
	f.calls = append(f.calls, "block")
	if f.onBlock != nil {
		f.onBlock()
	}
	return f.blockErr
}

func (f *fakeBackend) Unblock(context.Context) error {
	f.calls = append(f.calls, "unblock")
	return f.unblockErr
}

func ready() *fakeBackend { return &fakeBackend{available: true} }

func journalPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "cad-journal.json")
}

func exists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	if err == nil {
		return true
	}
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	t.Fatalf("stat %s: %v", path, err)
	return false
}

func wantCalls(t *testing.T, f *fakeBackend, want ...string) {
	t.Helper()
	if !slices.Equal(f.calls, want) {
		t.Fatalf("backend chaqiruvlari = %v, kutilgan %v", f.calls, want)
	}
}

func wantState(t *testing.T, got, want string) {
	t.Helper()
	if got != want {
		t.Fatalf("holat = %q, kutilgan %q", got, want)
	}
}

func TestUnavailableBackendReportsEdition(t *testing.T) {
	path := journalPath(t)
	f := &fakeBackend{available: false, reason: ReasonEdition}
	g := NewGuard(f, path)
	ctx := context.Background()

	wantState(t, g.Set(ctx, true), StateUnavailable)
	if g.Reason() != "edition" {
		t.Fatalf("sabab = %q, kutilgan edition", g.Reason())
	}
	wantState(t, g.State(), StateUnavailable)
	if exists(t, path) {
		t.Fatal("bloklab bo'lmaydigan nashrda jurnal yozilmasligi kerak")
	}

	// Nashr o'zgarmaydi: takroriy chaqiruv backend'dan qayta so'ramaydi va ochishda ham holat saqlanadi.
	wantState(t, g.Set(ctx, true), StateUnavailable)
	wantState(t, g.Set(ctx, false), StateUnavailable)
	wantCalls(t, f, "available")
}

func TestBlockThenUnblock(t *testing.T) {
	path := journalPath(t)
	f := ready()
	g := NewGuard(f, path)
	ctx := context.Background()

	var journalAtBlock string
	f.onBlock = func() {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("Block chaqirilganda jurnal yo'q: %v", err)
			return
		}
		journalAtBlock = string(raw)
	}

	wantState(t, g.Set(ctx, true), StateBlocked)
	wantState(t, g.State(), StateBlocked)
	if g.Reason() != "" {
		t.Fatalf("sabab = %q, bo'sh bo'lishi kerak", g.Reason())
	}
	if !strings.Contains(journalAtBlock, `"blocked"`) {
		t.Fatalf("jurnal Block'dan OLDIN 'blocked' bo'lishi kerak, o'qildi: %q", journalAtBlock)
	}
	wantCalls(t, f, "available", "block")

	// Idempotent: bloklangan holatda takroriy Set(true) PowerShell'ni qayta ishga tushirmaydi.
	for range 3 {
		wantState(t, g.Set(ctx, true), StateBlocked)
	}
	wantCalls(t, f, "available", "block")

	wantState(t, g.Set(ctx, false), StateOff)
	wantState(t, g.State(), StateOff)
	wantCalls(t, f, "available", "block", "unblock")
	if exists(t, path) {
		t.Fatal("ochilgandan keyin jurnal o'chirilgan bo'lishi kerak")
	}

	// Qaytariladigan narsa yo'q: Set(false) backend'ga tegmaydi.
	wantState(t, g.Set(ctx, false), StateOff)
	wantCalls(t, f, "available", "block", "unblock")

	// Keyingi dars: qayta bloklanadi (mavjudlik qayta so'ralmaydi).
	wantState(t, g.Set(ctx, true), StateBlocked)
	wantCalls(t, f, "available", "block", "unblock", "block")
}

func TestStartDisablesLeftoverFilter(t *testing.T) {
	path := journalPath(t)
	ctx := context.Background()

	// Birinchi "jarayon" bloklaydi va Unblock'siz o'ladi (qulash yoki o'chib qolgan kompyuter): jurnal qoladi.
	crashed := NewGuard(ready(), path)
	wantState(t, crashed.Set(ctx, true), StateBlocked)
	if !exists(t, path) {
		t.Fatal("bloklangan holatda jurnal bo'lishi kerak")
	}

	f := ready()
	g := NewGuard(f, path)
	g.Start(ctx)

	// Qoldiq tozalashdan oldin nashr bir marta tekshiriladi (edition bo'lsa Unblock keraksiz, TestLeftover...Edition).
	wantCalls(t, f, "available", "unblock")
	wantState(t, g.State(), StateOff)
	if exists(t, path) {
		t.Fatal("qoldiq tozalangach jurnal o'chirilgan bo'lishi kerak")
	}

	// Ikkinchi Start hech narsa qilmaydi.
	g.Start(ctx)
	wantCalls(t, f, "available", "unblock")
}

func TestStartWithoutJournalDoesNothing(t *testing.T) {
	f := ready()
	g := NewGuard(f, journalPath(t))
	g.Start(context.Background())

	wantCalls(t, f) // na Available, na Unblock: oddiy ishga tushishda PowerShell yo'q
	wantState(t, g.State(), StateOff)
}

func TestStartDoesNotUndoBlockMadeByThisProcess(t *testing.T) {
	f := ready()
	g := NewGuard(f, journalPath(t))
	ctx := context.Background()

	wantState(t, g.Set(ctx, true), StateBlocked)
	g.Start(ctx) // kech chaqirilgan Start: jurnal bu jarayonning o'z bloklashiniki, qoldiq emas

	wantCalls(t, f, "available", "block")
	wantState(t, g.State(), StateBlocked)
}

func TestStartFailureKeepsJournalAndLaterUnlockRetries(t *testing.T) {
	path := journalPath(t)
	ctx := context.Background()
	wantState(t, NewGuard(ready(), path).Set(ctx, true), StateBlocked)

	f := ready()
	f.unblockErr = errBoom
	g := NewGuard(f, path)
	g.Start(ctx)

	wantState(t, g.State(), StateFailed)
	if !strings.Contains(g.Reason(), errBoom.Error()) {
		t.Fatalf("sabab xatoni o'z ichiga olishi kerak: %q", g.Reason())
	}
	if !exists(t, path) {
		t.Fatal("tozalanmagan qoldiq jurnalda qolishi kerak")
	}

	f.unblockErr = nil
	wantState(t, g.Set(ctx, false), StateOff)
	wantCalls(t, f, "available", "unblock", "unblock")
	if exists(t, path) {
		t.Fatal("qayta urinish muvaffaqiyatli bo'lgach jurnal o'chirilishi kerak")
	}
}

// leftover oldingi jarayon bloklash paytida qulagani kabi jurnal qoldiradi.
func leftover(t *testing.T, path string) {
	t.Helper()
	wantState(t, NewGuard(ready(), path).Set(context.Background(), true), StateBlocked)
	if !exists(t, path) {
		t.Fatal("qoldiq jurnal yaratilmadi")
	}
}

func TestPendingTracksJournal(t *testing.T) {
	path := journalPath(t)
	g := NewGuard(ready(), path)
	ctx := context.Background()

	if g.Pending() {
		t.Fatal("jurnal yo'q: Pending false bo'lishi kerak")
	}
	g.Set(ctx, true)
	if !g.Pending() {
		t.Fatal("bloklangan holatda Pending true bo'lishi kerak")
	}
	g.Set(ctx, false)
	if g.Pending() {
		t.Fatal("ochilgandan keyin Pending false bo'lishi kerak")
	}

	// Buzilgan jurnal ham "qaytarish kerak".
	if err := os.WriteFile(path, []byte("bu json emas"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !g.Pending() {
		t.Fatal("buzilgan jurnalda Pending true bo'lishi kerak")
	}
	// O'qib bo'lmaydigan jurnal (fayl o'rnida katalog): Stat'dan o'tadi, lekin "yo'q" deb hisoblanmaydi.
	bad := filepath.Join(t.TempDir(), "cad-journal.json")
	if err := os.Mkdir(bad, 0o700); err != nil {
		t.Fatal(err)
	}
	if !NewGuard(ready(), bad).Pending() {
		t.Fatal("o'qib bo'lmaydigan jurnalda Pending true bo'lishi kerak")
	}
}

// Review Focus #3 (fix round 1): Start boot'da yiqilsa, bloklash holati o'zgarmaydi (reboot'dan keyin lock tiklanmaydi),
// Set chaqirilmaydi. Tozalashni Retry davom ettiradi.
func TestRetryClearsLeftoverAfterStartFailed(t *testing.T) {
	path := journalPath(t)
	ctx := context.Background()
	leftover(t, path)

	f := ready()
	f.unblockErr = errBoom // masalan, WMI provayderi boot'ning boshida hali tayyor emas
	g := NewGuard(f, path)
	g.Start(ctx)
	wantState(t, g.State(), StateFailed)
	if !g.Pending() {
		t.Fatal("Start yiqilgach Pending true bo'lishi kerak")
	}

	// Hali yiqilayotgan bo'lsa Retry jurnalni saqlaydi va yana urinadi.
	g.Retry(ctx)
	wantState(t, g.State(), StateFailed)
	if !g.Pending() || !exists(t, path) {
		t.Fatal("yiqilgan Retry jurnalni saqlashi kerak")
	}

	f.unblockErr = nil
	g.Retry(ctx)
	wantState(t, g.State(), StateOff)
	if g.Pending() || exists(t, path) {
		t.Fatal("muvaffaqiyatli Retry jurnalni o'chirishi kerak")
	}
	if g.Reason() != "" {
		t.Fatalf("sabab bo'sh bo'lishi kerak: %q", g.Reason())
	}
	wantCalls(t, f, "available", "unblock", "unblock", "unblock")

	// Tozalangach Retry hech narsa qilmaydi (PowerShell yo'q).
	g.Retry(ctx)
	g.Retry(ctx)
	wantCalls(t, f, "available", "unblock", "unblock", "unblock")
	wantState(t, g.State(), StateOff)
}

func TestRetryWithoutJournalDoesNothing(t *testing.T) {
	f := ready()
	g := NewGuard(f, journalPath(t))
	g.Retry(context.Background())

	wantCalls(t, f)
	wantState(t, g.State(), StateOff)
}

func TestRetryDoesNotUndoCurrentBlock(t *testing.T) {
	f := ready()
	g := NewGuard(f, journalPath(t))
	ctx := context.Background()

	wantState(t, g.Set(ctx, true), StateBlocked)
	g.Retry(ctx) // bloklash bor: Retry Set(true) ishiga aralashmaydi

	wantCalls(t, f, "available", "block")
	wantState(t, g.State(), StateBlocked)
	if !g.Pending() {
		t.Fatal("bloklangan holatda jurnal bor")
	}
}

// Nashr cheklovi aniq (funksiya/xizmat yo'q): filtr yoqilgan bo'lishi mumkin emas, jurnal PowerShell Unblock'siz
// o'chiriladi va Retry har 30 s da abadiy yiqilib turmaydi.
func TestLeftoverJournalIsDroppedWhenEditionIsDefinitive(t *testing.T) {
	path := journalPath(t)
	ctx := context.Background()
	leftover(t, path)

	f := &fakeBackend{available: false, reason: ReasonEdition, unblockErr: errBoom}
	g := NewGuard(f, path)
	g.Start(ctx)

	wantCalls(t, f, "available") // Unblock chaqirilmagan
	wantState(t, g.State(), StateUnavailable)
	if g.Reason() != ReasonEdition {
		t.Fatalf("sabab = %q, kutilgan edition", g.Reason())
	}
	if g.Pending() || exists(t, path) {
		t.Fatal("jurnal o'chirilishi kerak")
	}

	// Natija keshlangan: keyingi Retry va Set(true) backend'dan qayta so'ramaydi.
	g.Retry(ctx)
	wantState(t, g.Set(ctx, true), StateUnavailable)
	wantState(t, g.Set(ctx, false), StateUnavailable)
	wantCalls(t, f, "available")
}

func TestEditionDropAlsoCleansCorruptJournal(t *testing.T) {
	path := journalPath(t)
	if err := os.WriteFile(path, []byte("bu json emas"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := &fakeBackend{available: false, reason: ReasonEdition}
	g := NewGuard(f, path)
	g.Start(context.Background())

	wantCalls(t, f, "available")
	wantState(t, g.State(), StateUnavailable)
	if exists(t, path) {
		t.Fatal("buzilgan jurnal ham o'chirilishi kerak")
	}
}

// Mavjudlik so'rovi xato bersa (edition emas) filtr bor deb faraz qilinadi: Unblock baribir uriniladi.
func TestLeftoverJournalSurvivesProbeError(t *testing.T) {
	path := journalPath(t)
	ctx := context.Background()
	leftover(t, path)

	f := &fakeBackend{available: false, reason: "probe: powershell yiqildi"}
	g := NewGuard(f, path)
	g.Start(ctx)

	wantCalls(t, f, "available", "unblock")
	wantState(t, g.State(), StateOff)
	if g.Pending() {
		t.Fatal("Unblock muvaffaqiyatli bo'lgach jurnal o'chirilishi kerak")
	}
}

// Bu jarayon o'zi bloklagan bo'lsa nashr qayta so'ralmaydi (kesh) va jurnal faqat Unblock'dan keyin o'chadi.
func TestOwnBlockIsNotSubjectToEditionDrop(t *testing.T) {
	path := journalPath(t)
	f := ready()
	g := NewGuard(f, path)
	ctx := context.Background()

	wantState(t, g.Set(ctx, true), StateBlocked)
	wantState(t, g.Set(ctx, false), StateOff)
	wantCalls(t, f, "available", "block", "unblock")
}

func TestCorruptJournalIsTreatedAsBlocked(t *testing.T) {
	for name, content := range map[string]string{
		"garbage":       "bu json emas",
		"unknown state": `{"state":"maybe"}`,
		"extra field":   `{"state":"blocked","x":1}`,
		"trailing data": `{"state":"blocked"} {}`,
		"empty":         ``,
	} {
		t.Run(name, func(t *testing.T) {
			path := journalPath(t)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			f := ready()
			g := NewGuard(f, path)
			g.Start(context.Background())

			// Noaniq jurnal "bloklanmagan" deb o'qilmaydi: filtr yoqilgan bo'lishi mumkin, shuning uchun o'chiriladi.
			wantCalls(t, f, "available", "unblock")
			wantState(t, g.State(), StateOff)
			if exists(t, path) {
				t.Fatal("buzilgan jurnal tozalangach o'chirilishi kerak")
			}
		})
	}
}

func TestBlockFailureReportsFailed(t *testing.T) {
	path := journalPath(t)
	f := ready()
	f.blockErr = errBoom
	g := NewGuard(f, path)
	ctx := context.Background()

	wantState(t, g.Set(ctx, true), StateFailed)
	wantState(t, g.State(), StateFailed)
	if !strings.Contains(g.Reason(), errBoom.Error()) {
		t.Fatalf("sabab xatoni o'z ichiga olishi kerak: %q", g.Reason())
	}
	// Block yarim bajarilgan bo'lishi mumkin (Ctrl+Alt+Del yoqildi, Win+L yo'q): jurnal qoladi.
	if !exists(t, path) {
		t.Fatal("Block yiqilganda ham jurnal qolishi kerak (qisman yoqilgan filtr o'chirilishi uchun)")
	}

	// Muvaffaqiyatsiz holat qayta uriniladi.
	f.blockErr = nil
	wantState(t, g.Set(ctx, true), StateBlocked)
	wantCalls(t, f, "available", "block", "block")
	if g.Reason() != "" {
		t.Fatalf("muvaffaqiyatdan keyin sabab bo'sh bo'lishi kerak: %q", g.Reason())
	}
}

func TestFailedBlockIsCleanedUpOnUnlock(t *testing.T) {
	path := journalPath(t)
	f := ready()
	f.blockErr = errBoom
	g := NewGuard(f, path)
	ctx := context.Background()

	wantState(t, g.Set(ctx, true), StateFailed)
	wantState(t, g.Set(ctx, false), StateOff)
	wantCalls(t, f, "available", "block", "unblock")
	if exists(t, path) {
		t.Fatal("tozalangach jurnal o'chirilishi kerak")
	}
}

func TestUnblockFailureIsReappliedByNextLock(t *testing.T) {
	path := journalPath(t)
	f := ready()
	g := NewGuard(f, path)
	ctx := context.Background()

	wantState(t, g.Set(ctx, true), StateBlocked)
	f.unblockErr = errBoom
	wantState(t, g.Set(ctx, false), StateFailed)
	if !exists(t, path) {
		t.Fatal("Unblock yiqilganda jurnal qolishi kerak")
	}

	// Filtr qisman o'chgan bo'lishi mumkin: keyingi bloklash uni to'liq qayta o'rnatadi.
	wantState(t, g.Set(ctx, true), StateBlocked)
	wantCalls(t, f, "available", "block", "unblock", "block")

	f.unblockErr = nil
	wantState(t, g.Set(ctx, false), StateOff)
	if exists(t, path) {
		t.Fatal("jurnal o'chirilishi kerak")
	}
}

func TestJournalWriteFailureDoesNotBlock(t *testing.T) {
	// Katalog yo'q: jurnal yozilmaydi. Jurnalsiz bloklash qulaganda filtrni abadiy yoqilgan qoldirardi.
	path := filepath.Join(t.TempDir(), "yoq", "cad-journal.json")
	f := ready()
	g := NewGuard(f, path)

	wantState(t, g.Set(context.Background(), true), StateFailed)
	wantCalls(t, f, "available") // Block chaqirilmagan
	if g.Reason() == "" {
		t.Fatal("sabab bo'sh bo'lmasligi kerak")
	}
}

func TestProbeErrorReportsFailedAndIsRetried(t *testing.T) {
	path := journalPath(t)
	f := &fakeBackend{available: false, reason: "feature probe: powershell yiqildi"}
	g := NewGuard(f, path)
	ctx := context.Background()

	// "edition" bo'lmagan sabab — probe xatosi, nashr cheklovi emas: failed, va keshlanmaydi.
	wantState(t, g.Set(ctx, true), StateFailed)
	if g.Reason() != f.reason {
		t.Fatalf("sabab = %q, kutilgan %q", g.Reason(), f.reason)
	}
	if exists(t, path) {
		t.Fatal("probe yiqilganda jurnal yozilmasligi kerak")
	}

	f.available, f.reason = true, ""
	wantState(t, g.Set(ctx, true), StateBlocked)
	wantCalls(t, f, "available", "available", "block")
}

func TestProbeWithoutReasonIsStillFailure(t *testing.T) {
	g := NewGuard(&fakeBackend{available: false}, journalPath(t))
	wantState(t, g.Set(context.Background(), true), StateFailed)
	if g.Reason() == "" {
		t.Fatal("sabab bo'sh bo'lmasligi kerak")
	}
}

func TestUnlockAfterProbeFailureIsOff(t *testing.T) {
	f := &fakeBackend{available: false, reason: "probe xatosi"}
	g := NewGuard(f, journalPath(t))
	ctx := context.Background()

	wantState(t, g.Set(ctx, true), StateFailed)
	// Bloklash yo'q: qaytariladigan narsa yo'q, "failed" qolib ketmaydi.
	wantState(t, g.Set(ctx, false), StateOff)
	wantCalls(t, f, "available")
}

func TestNoTempFilesLeftBehind(t *testing.T) {
	dir := t.TempDir()
	g := NewGuard(ready(), filepath.Join(dir, "cad-journal.json"))
	ctx := context.Background()

	g.Set(ctx, true)
	g.Set(ctx, false)
	g.Set(ctx, true)

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "cad-journal.json" {
			t.Fatalf("katalogda ortiqcha fayl qolgan: %s", e.Name())
		}
	}
}

// slowBackend Block'da kutadi: State sekin PowerShell'ni kutib qolmasligini tekshirish uchun.
type slowBackend struct {
	fakeBackend
	entered chan struct{}
	release chan struct{}
}

func (s *slowBackend) Block(ctx context.Context) error {
	close(s.entered)
	<-s.release
	return nil
}

func TestStateDoesNotWaitForSlowBackend(t *testing.T) {
	s := &slowBackend{
		fakeBackend: fakeBackend{available: true},
		entered:     make(chan struct{}),
		release:     make(chan struct{}),
	}
	g := NewGuard(s, journalPath(t))

	done := make(chan string)
	go func() { done <- g.Set(context.Background(), true) }()
	<-s.entered

	read := make(chan string, 1)
	go func() { read <- g.State() }()
	select {
	case st := <-read:
		wantState(t, st, StateOff) // Block hali tugamagan
	case <-time.After(2 * time.Second):
		t.Fatal("State sekin backend'ni kutib qoldi")
	}

	close(s.release)
	wantState(t, <-done, StateBlocked)
}

// Probe ishga tushishda Pro/Home'da darhol `unavailable` beradi (birinchi bloklashni kutmasdan).
func TestProbeReportsEditionAtBoot(t *testing.T) {
	f := &fakeBackend{available: false, reason: ReasonEdition}
	g := NewGuard(f, journalPath(t))
	g.Probe()
	wantState(t, g.State(), StateUnavailable)
	if g.Reason() != ReasonEdition {
		t.Fatalf("sabab = %q", g.Reason())
	}
	// Natija keshlanadi: keyingi Set backend'dan qayta so'ramaydi.
	wantState(t, g.Set(context.Background(), true), StateUnavailable)
	wantCalls(t, f, "available")
}

func TestProbeKeepsOffWhenAvailable(t *testing.T) {
	f := ready()
	g := NewGuard(f, journalPath(t))
	g.Probe()
	wantState(t, g.State(), StateOff)
	wantCalls(t, f, "available")
}

// Probe xatosi bloklash yo'q paytida `failed` demaydi (hech narsa to'silmagan): holat `off` qoladi.
func TestProbeErrorKeepsOff(t *testing.T) {
	f := &fakeBackend{available: false, reason: "WMI tayyor emas"}
	g := NewGuard(f, journalPath(t))
	g.Probe()
	wantState(t, g.State(), StateOff)
}

// Qoldiq jurnal yoki joriy bloklash bor paytida Probe hech narsa qilmaydi (bu Start/Retry/Set ishi).
func TestProbeSkipsWhilePending(t *testing.T) {
	path := journalPath(t)
	if err := os.WriteFile(path, []byte(`{"state":"blocked"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	f := ready()
	g := NewGuard(f, path)
	g.Probe()
	wantCalls(t, f)
}

// Qoldiq jurnal bor (oldingi ish bloklash paytida qulagan), lock tiklangan: Set(true) avval ochmasdan bloklaydi.
func TestBlockOverLeftoverJournalDoesNotUnblockFirst(t *testing.T) {
	path := journalPath(t)
	if err := os.WriteFile(path, []byte(`{"state":"blocked"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	f := ready()
	g := NewGuard(f, path)
	wantState(t, g.Set(context.Background(), true), StateBlocked)
	wantCalls(t, f, "available", "block")
	if !exists(t, path) {
		t.Fatal("jurnal yo'qoldi")
	}
}
