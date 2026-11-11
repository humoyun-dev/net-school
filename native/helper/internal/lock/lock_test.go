package lock

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

// fakeClock: test uptime'ni qo'lda suradi.
type fakeClock struct {
	uptime time.Duration
	boot   string
}

func (c *fakeClock) Now() time.Time          { return time.Unix(1_800_000_000, 0).Add(c.uptime) }
func (c *fakeClock) Uptime() time.Duration   { return c.uptime }
func (c *fakeClock) BootID() string          { return c.boot }
func (c *fakeClock) advance(d time.Duration) { c.uptime += d }

// memStore xotirada saqlaydi va chaqiruvlarni sanaydi.
type memStore struct {
	saved   *Saved
	saves   int
	clears  int
	loadErr error
	saveErr error
}

func (s *memStore) Load() (Saved, bool, error) {
	if s.loadErr != nil {
		return Saved{}, false, s.loadErr
	}
	if s.saved == nil {
		return Saved{}, false, nil
	}
	return *s.saved, true, nil
}

func (s *memStore) Save(v Saved) error {
	s.saves++
	if s.saveErr != nil {
		return s.saveErr
	}
	s.saved = &v
	return nil
}

func (s *memStore) Clear() error {
	s.clears++
	s.saved = nil
	return nil
}

func seq(v string) *string { return &v }

func locked(sequence string) hub.LockState {
	return hub.LockState{Locked: true, Sequence: seq(sequence), LeaseSeconds: 120}
}

func unlocked(sequence string) hub.LockState {
	return hub.LockState{Locked: false, Sequence: seq(sequence), LeaseSeconds: 120}
}

func newLock(boot string) (*Lock, *fakeClock, *memStore) {
	clock := &fakeClock{uptime: 1000 * time.Second, boot: boot}
	store := &memStore{}
	return New(clock, store), clock, store
}

func TestLockAppliesOnlyNewerSequence(t *testing.T) {
	l, _, _ := newLock("boot-1")
	l.Apply(locked("5"))
	if !l.Locked() {
		t.Fatal("lock(5) qo'llanmadi")
	}
	// Eskiroq unlock hech narsani o'zgartirmaydi.
	l.Apply(unlocked("4"))
	if !l.Locked() {
		t.Fatal("eskiroq unlock(4) lock(5)ni ochib yubordi")
	}
	// Teng sequence qo'llanadi.
	l.Apply(unlocked("5"))
	if l.Locked() {
		t.Fatal("teng sequence'li unlock(5) qo'llanmadi")
	}
	// Eskiroq lock ochiq holatni qayta yopmaydi.
	l.Apply(locked("4"))
	if l.Locked() {
		t.Fatal("eskiroq lock(4) qo'llandi")
	}
	// Yangiroq lock qo'llanadi.
	l.Apply(locked("6"))
	if !l.Locked() {
		t.Fatal("yangiroq lock(6) qo'llanmadi")
	}
}

func TestSequenceIsComparedNumerically(t *testing.T) {
	l, _, _ := newLock("boot-1")
	l.Apply(locked("9"))
	// Satr sifatida "10" < "9", son sifatida esa yangiroq.
	l.Apply(unlocked("10"))
	if l.Locked() {
		t.Fatal("unlock(10) lock(9)dan yangiroq, qo'llanishi kerak edi")
	}
	// uint64 chegarasi.
	l.Apply(locked("18446744073709551615"))
	if !l.Locked() {
		t.Fatal("eng katta uint64 sequence qo'llanmadi")
	}
	l.Apply(unlocked("18446744073709551614"))
	if !l.Locked() {
		t.Fatal("eskiroq sequence qo'llandi")
	}
}

func TestInvalidSequenceIsIgnored(t *testing.T) {
	l, _, store := newLock("boot-1")
	l.Apply(locked("5"))
	for _, bad := range []string{"", "abc", "-1", "+5", "1.5", "18446744073709551616", " 7"} {
		l.Apply(unlocked(bad))
		if !l.Locked() {
			t.Fatalf("noto'g'ri sequence %q holatni o'zgartirdi", bad)
		}
	}
	if store.clears != 0 {
		t.Fatalf("noto'g'ri sequence store'ni tozaladi (%d marta)", store.clears)
	}
}

func TestNoLessonUnlocksAndForgetsSequence(t *testing.T) {
	l, _, store := newLock("boot-1")
	l.Apply(locked("50"))
	// Dars tugadi: hub `locked:false, sequence:null` qaytaradi, helper darhol ochiladi (Companion `applyHeartbeat(null)` kabi).
	l.Apply(hub.LockState{Locked: false, Sequence: nil, LeaseSeconds: 120})
	if l.Locked() {
		t.Fatal("dars tugagach helper ochilmadi")
	}
	if store.saved != nil {
		t.Fatal("dars tugagach store tozalanmadi")
	}
	// Sequence unutilgan: yangi darsning kichikroq sequence'i ham qo'llanadi.
	l.Apply(locked("3"))
	if !l.Locked() {
		t.Fatal("dars tugagach sequence unutilmadi")
	}
}

func TestLockWithoutSequenceOrdersBeforeAnyNumber(t *testing.T) {
	l, _, _ := newLock("boot-1")
	l.Apply(hub.LockState{Locked: true, Sequence: nil, LeaseSeconds: 120})
	if !l.Locked() {
		t.Fatal("sequence'siz lock qo'llanmadi")
	}
	l.Apply(unlocked("1"))
	if l.Locked() {
		t.Fatal("raqamli sequence sequence'sizdan yangiroq, qo'llanishi kerak edi")
	}
	// Endi sequence'siz lock eskirgan.
	l.Apply(hub.LockState{Locked: true, Sequence: nil, LeaseSeconds: 120})
	if l.Locked() {
		t.Fatal("eskirgan sequence'siz lock raqamliga ustun keldi")
	}
}

func TestLeaseExpiresWithoutHub(t *testing.T) {
	l, clock, store := newLock("boot-1")
	l.Apply(locked("5"))

	clock.advance(119 * time.Second)
	l.Tick()
	if !l.Locked() {
		t.Fatal("lease tugamasdan ochildi (119 s)")
	}

	clock.advance(2 * time.Second) // jami 121 s
	l.Tick()
	if l.Locked() {
		t.Fatal("hub yo'q, 121 s o'tdi, lekin helper hamon bloklangan")
	}
	if store.saved != nil {
		t.Fatal("lease tugagach store tozalanmadi")
	}
}

func TestLeaseExpiresExactlyAtDeadline(t *testing.T) {
	l, clock, _ := newLock("boot-1")
	l.Apply(locked("5"))
	clock.advance(120 * time.Second)
	l.Tick()
	if l.Locked() {
		t.Fatal("uptime == deadline bo'lganda ochilishi kerak (uptime >= deadline)")
	}
}

func TestHubRefreshExtendsLease(t *testing.T) {
	l, clock, _ := newLock("boot-1")
	l.Apply(locked("5"))
	clock.advance(100 * time.Second)
	l.Apply(locked("5")) // hub har 5 s tasdiqlaydi
	clock.advance(100 * time.Second)
	l.Tick()
	if !l.Locked() {
		t.Fatal("yangilangan lease 100 s da tugadi")
	}
	clock.advance(21 * time.Second)
	l.Tick()
	if l.Locked() {
		t.Fatal("yangilangan lease 121 s dan keyin ham tugamadi")
	}
}

func TestStaleStateDoesNotExtendLease(t *testing.T) {
	l, clock, _ := newLock("boot-1")
	l.Apply(locked("5"))
	clock.advance(100 * time.Second)
	l.Apply(locked("4")) // eskirgan: lease'ni ham yangilamaydi
	clock.advance(21 * time.Second)
	l.Tick()
	if l.Locked() {
		t.Fatal("eskirgan lock lease'ni uzaytirdi")
	}
}

func TestExpiredLockIsRelockedByEqualSequence(t *testing.T) {
	l, clock, _ := newLock("boot-1")
	l.Apply(locked("5"))
	clock.advance(121 * time.Second)
	l.Tick()
	if l.Locked() {
		t.Fatal("lease tugamadi")
	}
	// Hub qaytib keldi va lock'ni tasdiqlaydi: sequence saqlangan, teng sequence qo'llanadi.
	l.Apply(locked("5"))
	if !l.Locked() {
		t.Fatal("hub tiklangach bir xil sequence qayta bloklamadi")
	}
}

func TestLockPersistsAndUnlockClearsStore(t *testing.T) {
	l, clock, store := newLock("boot-1")
	l.Apply(locked("7"))
	if store.saved == nil {
		t.Fatal("lock store'ga saqlanmadi")
	}
	got := *store.saved
	wantDeadline := (clock.uptime + 120*time.Second).Milliseconds()
	if got.BootID != "boot-1" || got.Sequence == nil || *got.Sequence != 7 || got.DeadlineUptimeMs != wantDeadline {
		t.Fatalf("saqlangan = %+v, want boot-1 / sequence 7 / deadline %d ms", got, wantDeadline)
	}
}

func TestUnlockClearsStore(t *testing.T) {
	l, _, store := newLock("boot-1")
	l.Apply(locked("7"))
	if store.saved == nil {
		t.Fatal("lock saqlanmadi")
	}
	l.Apply(unlocked("8"))
	if l.Locked() {
		t.Fatal("unlock qo'llanmadi")
	}
	if store.saved != nil || store.clears == 0 {
		t.Fatalf("unlock store'ni tozalamadi (saved=%v, clears=%d)", store.saved, store.clears)
	}
}

func TestIdleDoesNotTouchStore(t *testing.T) {
	l, _, store := newLock("boot-1")
	for range 3 {
		l.Apply(hub.LockState{Locked: false, Sequence: nil, LeaseSeconds: 120})
		l.Tick()
	}
	if store.saves != 0 || store.clears != 0 {
		t.Fatalf("bo'sh holat store'ga tegdi: saves=%d clears=%d", store.saves, store.clears)
	}
}

func TestRestoreOnlyWithinSameBoot(t *testing.T) {
	// Birinchi jarayon: lock qo'llaydi va saqlaydi.
	first, clock, store := newLock("boot-1")
	first.Apply(locked("7"))
	if store.saved == nil {
		t.Fatal("lock saqlanmadi")
	}

	t.Run("same boot restores", func(t *testing.T) {
		clock.advance(30 * time.Second)
		second := New(clock, store)
		second.Restore()
		if !second.Locked() {
			t.Fatal("bir xil boot'da saqlangan lock tiklanmadi")
		}
		// Tiklangan sequence eskirgan holatni o'tkazmaydi.
		second.Apply(unlocked("6"))
		if !second.Locked() {
			t.Fatal("tiklangan lock eskiroq unlock bilan ochildi")
		}
		// Qolgan lease saqlangan deadline bo'yicha: 120 - 30 = 90 s.
		clock.advance(89 * time.Second)
		second.Tick()
		if !second.Locked() {
			t.Fatal("tiklangan lock lease tugamasdan ochildi")
		}
		clock.advance(2 * time.Second)
		second.Tick()
		if second.Locked() {
			t.Fatal("tiklangan lock saqlangan deadline'dan keyin ham yopiq")
		}
	})

	t.Run("other boot does not restore", func(t *testing.T) {
		other, otherClock, otherStore := newLock("boot-1")
		other.Apply(locked("7"))
		rebooted := &fakeClock{uptime: otherClock.uptime, boot: "boot-2"}
		l := New(rebooted, otherStore)
		l.Restore()
		if l.Locked() {
			t.Fatal("boshqa boot'dagi lock tiklandi")
		}
		if otherStore.saved != nil {
			t.Fatal("boshqa boot'dagi lock store'dan o'chirilmadi")
		}
	})

	t.Run("expired deadline does not restore", func(t *testing.T) {
		l1, c, s := newLock("boot-1")
		l1.Apply(locked("7"))
		c.advance(121 * time.Second)
		l2 := New(c, s)
		l2.Restore()
		if l2.Locked() {
			t.Fatal("lease'i tugagan lock tiklandi")
		}
		if s.saved != nil {
			t.Fatal("eskirgan lock store'dan o'chirilmadi")
		}
	})

	t.Run("deadline exactly now does not restore", func(t *testing.T) {
		l1, c, s := newLock("boot-1")
		l1.Apply(locked("7"))
		c.advance(120 * time.Second)
		l2 := New(c, s)
		l2.Restore()
		if l2.Locked() {
			t.Fatal("deadline == uptime bo'lganda lock tiklandi")
		}
	})
}

func TestRestoreWithoutSavedStateIsNoop(t *testing.T) {
	l, _, store := newLock("boot-1")
	l.Restore()
	if l.Locked() {
		t.Fatal("saqlangan holat yo'q, lekin bloklangan")
	}
	if store.clears != 0 {
		t.Fatal("bo'sh store tozalandi")
	}
}

func TestRestoreFromBrokenStoreStaysUnlockedAndClears(t *testing.T) {
	l, _, store := newLock("boot-1")
	store.loadErr = errors.New("buzilgan fayl")
	l.Restore()
	if l.Locked() {
		t.Fatal("o'qib bo'lmagan store'dan lock tiklandi")
	}
	if store.clears == 0 {
		t.Fatal("buzilgan store tozalanmadi")
	}
	if l.StoreErr() == nil {
		t.Fatal("store xatosi StoreErr'da ko'rinmadi")
	}
}

func TestStoreErrorIsReportedButLockStillApplies(t *testing.T) {
	l, _, store := newLock("boot-1")
	store.saveErr = errors.New("disk to'la")
	l.Apply(locked("5"))
	if !l.Locked() {
		t.Fatal("store xatosi lock'ni qo'llashga to'sqinlik qildi")
	}
	if l.StoreErr() == nil {
		t.Fatal("store xatosi ko'rinmadi")
	}
	store.saveErr = nil
	l.Apply(locked("5"))
	if err := l.StoreErr(); err != nil {
		t.Fatalf("muvaffaqiyatli saqlashdan keyin StoreErr = %v", err)
	}
}

func TestNonPositiveLeaseFallsBackToDefault(t *testing.T) {
	l, clock, _ := newLock("boot-1")
	l.Apply(hub.LockState{Locked: true, Sequence: seq("1"), LeaseSeconds: 0})
	l.Tick()
	if !l.Locked() {
		t.Fatal("lease'siz lock darhol tushdi")
	}
	clock.advance(DefaultLease - time.Second)
	l.Tick()
	if !l.Locked() {
		t.Fatal("default lease tugamasdan tushdi")
	}
	clock.advance(2 * time.Second)
	l.Tick()
	if l.Locked() {
		t.Fatal("default lease tugagach ham yopiq")
	}
}

func u64(v uint64) *uint64 { return &v }

// --- FileStore ---

func TestFileStoreRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.json")
	store := NewFileStore(path)

	if _, ok, err := store.Load(); ok || err != nil {
		t.Fatalf("fayl yo'q: ok=%v err=%v, want false/nil", ok, err)
	}

	in := Saved{BootID: "boot-1", Sequence: u64(18446744073709551615), DeadlineUptimeMs: 123456}
	if err := store.Save(in); err != nil {
		t.Fatal(err)
	}
	out, ok, err := store.Load()
	if err != nil || !ok {
		t.Fatalf("Load: ok=%v err=%v", ok, err)
	}
	if out.BootID != in.BootID || out.DeadlineUptimeMs != in.DeadlineUptimeMs || out.Sequence == nil || *out.Sequence != *in.Sequence {
		t.Fatalf("Load = %+v, want %+v", out, in)
	}

	// Sequence'siz holat ham aylanib keladi.
	if err := store.Save(Saved{BootID: "b", DeadlineUptimeMs: 1}); err != nil {
		t.Fatal(err)
	}
	out, ok, err = store.Load()
	if err != nil || !ok || out.Sequence != nil {
		t.Fatalf("sequence'siz Load = %+v ok=%v err=%v", out, ok, err)
	}

	if err := store.Clear(); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.Load(); ok || err != nil {
		t.Fatalf("Clear'dan keyin: ok=%v err=%v", ok, err)
	}
	// Mavjud bo'lmagan faylni tozalash xato emas.
	if err := store.Clear(); err != nil {
		t.Fatalf("ikkinchi Clear: %v", err)
	}
}

func TestFileStoreWritesAtomicallyWithoutLeftovers(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(filepath.Join(dir, "lock.json"))
	for i := range 5 {
		if err := store.Save(Saved{BootID: "b", Sequence: u64(uint64(i)), DeadlineUptimeMs: int64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "lock.json" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("katalogda lock.json'dan boshqa fayllar qoldi: %v", names)
	}
}

func TestFileStoreSaveFailsWithoutDirectory(t *testing.T) {
	// Katalogni yaratish va uning ACL'i xizmatning ishi; store o'zi katalog yaratmaydi.
	store := NewFileStore(filepath.Join(t.TempDir(), "missing", "lock.json"))
	if err := store.Save(Saved{BootID: "b"}); err == nil {
		t.Fatal("katalog yo'q, lekin Save xato bermadi")
	}
}

func TestFileStoreRejectsCorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.json")
	for name, content := range map[string]string{
		"not json":      "{",
		"unknown field": `{"bootId":"b","deadlineUptimeMs":1,"extra":true}`,
		"empty boot id": `{"bootId":"","deadlineUptimeMs":1}`,
		"trailing data": `{"bootId":"b","deadlineUptimeMs":1} {}`,
		"negative seq":  `{"bootId":"b","sequence":-1,"deadlineUptimeMs":1}`,
	} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok, err := NewFileStore(path).Load(); err == nil || ok {
			t.Errorf("%s: Load ok=%v err=%v, want error", name, ok, err)
		}
	}
}

func TestRestoreFromCorruptFileClearsIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	clock := &fakeClock{uptime: time.Hour, boot: "boot-1"}
	l := New(clock, NewFileStore(path))
	l.Restore()
	if l.Locked() {
		t.Fatal("buzilgan fayldan lock tiklandi")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("buzilgan fayl o'chirilmadi: %v", err)
	}
}

func TestLockSurvivesProcessRestartThroughFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.json")
	clock := &fakeClock{uptime: time.Hour, boot: "boot-1"}
	New(clock, NewFileStore(path)).Apply(locked("12"))

	clock.advance(10 * time.Second)
	restarted := New(clock, NewFileStore(path))
	restarted.Restore()
	if !restarted.Locked() {
		t.Fatal("jarayon qayta ishga tushgach lock fayldan tiklanmadi")
	}
}
