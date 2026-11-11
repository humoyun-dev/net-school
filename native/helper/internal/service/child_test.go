package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
	"github.com/humoyun-dev/net-school/native/helper/internal/supervise"
)

const waitLimit = 3 * time.Second

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitLimit)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("kutilmadi: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// fakeProc Kill qilinguncha yashaydi.
type fakeProc struct {
	once sync.Once
	done chan struct{}
}

func (p *fakeProc) Wait() error { <-p.done; return errors.New("o'ldirildi") }
func (p *fakeProc) Kill() error { p.once.Do(func() { close(p.done) }); return nil }

// recordingLaunchers har sessiya uchun ishga tushirilgan jarayonlarni yozadi.
type recordingLaunchers struct {
	mu      sync.Mutex
	started map[string][]*fakeProc
}

type sessionLauncher struct {
	r *recordingLaunchers
	s Session
}

func (l sessionLauncher) Start() (supervise.Proc, error) {
	p := &fakeProc{done: make(chan struct{})}
	l.r.mu.Lock()
	defer l.r.mu.Unlock()
	l.r.started[l.s.UserSID] = append(l.r.started[l.s.UserSID], p)
	return p, nil
}

func (r *recordingLaunchers) count(sid string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.started[sid])
}

func (r *recordingLaunchers) alive(sid string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, p := range r.started[sid] {
		select {
		case <-p.done:
		default:
			n++
		}
	}
	return n
}

func TestChildMovesToNewSession(t *testing.T) {
	r := &recordingLaunchers{started: map[string][]*fakeProc{}}
	c := NewSessionChild("companion", func(s Session) supervise.Launcher { return sessionLauncher{r, s} }, supervise.SystemClock{})
	if c.State() != supervise.StateStopped {
		t.Fatalf("boshlang'ich holat = %q", c.State())
	}
	c.Move(Session{ID: 2, UserSID: sidA}, true)
	eventually(t, "A sessiyasida ishga tushish", func() bool { return r.alive(sidA) == 1 && c.State() == supervise.StateRunning })

	c.Move(Session{ID: 3, UserSID: sidB}, true)
	if r.alive(sidA) != 0 {
		t.Fatal("eski sessiyadagi jarayon o'ldirilmadi")
	}
	eventually(t, "B sessiyasida ishga tushish", func() bool { return r.alive(sidB) == 1 })

	c.Move(Session{}, false)
	if r.alive(sidB) != 0 || c.State() != supervise.StateStopped {
		t.Fatalf("sessiyasiz to'xtamadi: alive=%d state=%q", r.alive(sidB), c.State())
	}
	if r.count(sidA) != 1 || r.count(sidB) != 1 {
		t.Fatalf("ortiqcha ishga tushirish: A=%d B=%d", r.count(sidA), r.count(sidB))
	}
	// Oxirgi xato to'xtatilgan Supervisor'dan keyin ham ko'rinadi.
	if c.LastError() == nil {
		t.Fatal("LastError yo'qoldi")
	}
}

// Hub konfiguratsiyasi (device.json, helper.key) hali yo'q bo'lsa xizmat baribir ishlaydi va yuklashni
// HubLoadRetry oralig'ida qayta urinadi (har Step'da emas).
func TestLazyHubRetriesLoad(t *testing.T) {
	clock := &fakeClock{t: time.Hour}
	inner := &fakeHub{}
	loadErr := errors.New("device.json yo'q")
	loads := 0
	h := NewLazyHub(func() (Hub, error) {
		loads++
		if loadErr != nil {
			return nil, loadErr
		}
		return inner, nil
	}, clock)
	ctx := context.Background()
	if _, err := h.LockState(ctx); !errors.Is(err, loadErr) {
		t.Fatalf("LockState = %v", err)
	}
	if err := h.ReportStatus(ctx, hub.Status{}); !errors.Is(err, loadErr) || loads != 1 {
		t.Fatalf("ReportStatus = %v, loads = %d (oraliqdan oldin qayta yuklanmasligi kerak)", err, loads)
	}
	clock.t += HubLoadRetry
	loadErr = nil
	if _, err := h.LockState(ctx); err != nil || loads != 2 || inner.polls != 1 {
		t.Fatalf("LockState = %v, loads = %d, polls = %d", err, loads, inner.polls)
	}
	if _, err := h.LockState(ctx); err != nil || loads != 2 {
		t.Fatalf("yuklangan hub qayta yuklandi: loads = %d", loads)
	}
}

func TestParseDeviceConfig(t *testing.T) {
	raw := []byte(`{"hubOrigin":"https://hub.school","deviceId":"7c2b3a4e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
		"siteId":"7c2b3a4e-1d2f-4a5b-8c9d-0e1f2a3b4c5e","publicKey":"abc","enrolledAt":"2026-11-01T00:00:00Z"}`)
	cfg, err := ParseDeviceConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HubOrigin != "https://hub.school" || cfg.DeviceID != "7c2b3a4e-1d2f-4a5b-8c9d-0e1f2a3b4c5d" {
		t.Fatalf("config = %+v", cfg)
	}
	for _, bad := range []string{
		`{}`,
		`{"hubOrigin":"https://hub.school"}`,
		`{"hubOrigin":"","deviceId":"7c2b3a4e-1d2f-4a5b-8c9d-0e1f2a3b4c5d"}`,
		`{"hubOrigin":"https://hub.school","deviceId":"../x"}`,
		`not json`,
	} {
		if _, err := ParseDeviceConfig([]byte(bad)); err == nil {
			t.Fatalf("%s qabul qilindi", bad)
		}
	}
}
