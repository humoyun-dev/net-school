package service

import (
	"errors"
	"testing"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/lock"
)

type fakeClockForGate struct{ t time.Duration }

func (c *fakeClockForGate) Uptime() time.Duration { return c.t }

// Tekshirilmagan katalogdan (hardening yiqilgan yoki egasi/DACL hali begona) hub konfiguratsiyasi o'qilmaydi;
// hardening + tekshiruv VerifyRetry (60 s) oralig'ida qayta uriniladi, o'tgach konfiguratsiya yuklanadi.
func TestUnverifiedConfigDirIsRetriedAndNeverRead(t *testing.T) {
	clock := &fakeClockForGate{}
	verifies, verifyOK := 0, false
	gate := NewDirGate(func() bool { verifies++; return verifyOK }, clock)
	loads := 0
	load := GatedLoad(gate, func() (Hub, error) { loads++; return nil, nil })

	if _, err := load(); !errors.Is(err, ErrUntrustedConfigDir) {
		t.Fatalf("err = %v, want ErrUntrustedConfigDir", err)
	}
	if verifies != 1 || loads != 0 {
		t.Fatalf("verifies=%d loads=%d", verifies, loads)
	}
	// 60 s ichida qayta tekshirilmaydi.
	clock.t += VerifyRetry - time.Second
	if _, err := load(); !errors.Is(err, ErrUntrustedConfigDir) || verifies != 1 {
		t.Fatalf("err=%v verifies=%d", err, verifies)
	}
	// 60 s o'tdi, hali ham begona.
	clock.t += time.Second
	if gate.Verified() || verifies != 2 {
		t.Fatalf("verifies=%d", verifies)
	}
	// Keyingi urinishda o'tadi: konfiguratsiya yuklanadi, keyin qayta tekshirilmaydi.
	verifyOK = true
	clock.t += VerifyRetry
	if _, err := load(); err != nil || loads != 1 || verifies != 3 {
		t.Fatalf("err=%v loads=%d verifies=%d", err, loads, verifies)
	}
	clock.t += 10 * VerifyRetry
	if !gate.Verified() || verifies != 3 {
		t.Fatalf("verifies=%d", verifies)
	}
}

type recordingStore struct{ loads, saves, clears int }

func (s *recordingStore) Load() (lock.Saved, bool, error) {
	s.loads++
	return lock.Saved{BootID: "b"}, true, nil
}
func (s *recordingStore) Save(lock.Saved) error { s.saves++; return nil }
func (s *recordingStore) Clear() error          { s.clears++; return nil }

// Tekshirilmagan katalogda lock.json o'qilmaydi (ochiq holatdan boshlanadi) va yozilmaydi.
func TestUnverifiedDirStartsUnlocked(t *testing.T) {
	clock := &fakeClockForGate{}
	ok := false
	gate := NewDirGate(func() bool { return ok }, clock)
	inner := &recordingStore{}
	store := GatedStore(gate, inner)
	if _, found, err := store.Load(); found || err != nil {
		t.Fatalf("found=%v err=%v", found, err)
	}
	if err := store.Save(lock.Saved{}); !errors.Is(err, ErrUntrustedConfigDir) {
		t.Fatalf("Save err = %v", err)
	}
	if inner.loads+inner.saves != 0 {
		t.Fatalf("ichki store'ga tegildi: %+v", inner)
	}
	ok = true
	clock.t += VerifyRetry
	if _, found, _ := store.Load(); !found || inner.loads != 1 {
		t.Fatalf("tekshirilgandan keyin o'qilmadi: %+v", inner)
	}
	if err := store.Save(lock.Saved{}); err != nil || inner.saves != 1 {
		t.Fatalf("Save: %v %+v", err, inner)
	}
}
