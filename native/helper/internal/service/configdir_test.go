package service

import (
	"errors"
	"testing"
	"time"
)

// Tekshirilmagan katalogdan (hardening yiqilgan yoki egasi/DACL hali begona) hub konfiguratsiyasi umuman o'qilmaydi.
func TestUnverifiedConfigDirIsNeverRead(t *testing.T) {
	called := 0
	load := func() (Hub, error) { called++; return nil, nil }
	if _, err := GuardedLoad(false, load)(); !errors.Is(err, ErrUntrustedConfigDir) {
		t.Fatalf("err = %v, want ErrUntrustedConfigDir", err)
	}
	if called != 0 {
		t.Fatalf("load %d marta chaqirildi", called)
	}
	// LazyHub orqali ham: qayta urinishda ham o'qilmaydi, xizmat hub'siz (ochiq) ishlaydi.
	clock := &fakeClockForGate{}
	h := NewLazyHub(GuardedLoad(false, load), clock)
	for i := 0; i < 3; i++ {
		clock.t += HubLoadRetry
		if _, err := h.LockState(t.Context()); !errors.Is(err, ErrUntrustedConfigDir) {
			t.Fatalf("LockState err = %v", err)
		}
	}
	if called != 0 {
		t.Fatalf("load %d marta chaqirildi", called)
	}
	if _, err := GuardedLoad(true, load)(); err != nil || called != 1 {
		t.Fatalf("tekshirilgan katalog: err=%v called=%d", err, called)
	}
}

type fakeClockForGate struct{ t time.Duration }

func (c *fakeClockForGate) Uptime() time.Duration { return c.t }
