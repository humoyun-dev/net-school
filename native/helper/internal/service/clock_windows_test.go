//go:build windows

package service

import (
	"strings"
	"testing"
	"time"
)

func TestSystemClockIsStableWithinBoot(t *testing.T) {
	a, b := newSystemClock(), newSystemClock()
	if a.BootID() == "" || a.BootID() != b.BootID() {
		t.Fatalf("BootID = %q va %q", a.BootID(), b.BootID())
	}
	if !strings.HasPrefix(a.BootID(), "reg:") && !strings.HasPrefix(a.BootID(), "t:") {
		t.Fatalf("BootID formati = %q", a.BootID())
	}
	u1 := a.Uptime()
	time.Sleep(20 * time.Millisecond)
	if u2 := a.Uptime(); u1 <= 0 || u2 < u1 {
		t.Fatalf("Uptime monoton emas: %v -> %v", u1, u2)
	}
}
