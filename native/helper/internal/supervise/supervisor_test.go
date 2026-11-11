package supervise

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"
)

// fakeClock: Sleep kutmaydi, faqat davomiylikni yozib oladi va vaqtni suradi. Proc.Wait ham vaqtni suradi.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	sleeps []time.Duration
}

func newFakeClock() *fakeClock { return &fakeClock{now: time.Unix(1_800_000_000, 0)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sleeps = append(c.sleeps, d)
	c.now = c.now.Add(d)
	return nil
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func (c *fakeClock) recorded() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.sleeps)
}

// fakeProc: lifetime >= 0 bo'lsa Wait vaqtni shuncha surib darhol qaytadi (jarayon o'zi tugadi);
// forever bo'lsa Wait Kill'gacha bloklanadi.
type fakeProc struct {
	clock    *fakeClock
	lifetime time.Duration
	forever  bool

	killErr error // nil bo'lmasa Kill shu xatoni qaytaradi va jarayonni to'xtatmaydi

	once   sync.Once
	killed chan struct{}
	mu     sync.Mutex
	kills  int
}

func (p *fakeProc) Wait() error {
	if !p.forever {
		p.clock.advance(p.lifetime)
		return errors.New("exit status 1")
	}
	<-p.killed
	return errors.New("killed")
}

func (p *fakeProc) Kill() error {
	p.mu.Lock()
	p.kills++
	p.mu.Unlock()
	if p.killErr != nil {
		return p.killErr
	}
	p.once.Do(func() { close(p.killed) })
	return nil
}

func (p *fakeProc) killCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.kills
}

// fakeLauncher: n-chi Start (0 dan) step(n) natijasini qaytaradi.
type fakeLauncher struct {
	mu     sync.Mutex
	starts int
	step   func(n int) (Proc, error)
}

func (l *fakeLauncher) Start() (Proc, error) {
	l.mu.Lock()
	n := l.starts
	l.starts++
	l.mu.Unlock()
	return l.step(n)
}

func (l *fakeLauncher) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.starts
}

// scripted: lifetimes bo'yicha jarayonlar beradi; ro'yxat tugagach abadiy jarayon beradi va ctx'ni bekor qiladi.
func scripted(clock *fakeClock, cancel context.CancelFunc, lifetimes ...time.Duration) (*fakeLauncher, *fakeProc) {
	last := &fakeProc{clock: clock, forever: true, killed: make(chan struct{})}
	l := &fakeLauncher{step: func(n int) (Proc, error) {
		if n < len(lifetimes) {
			return &fakeProc{clock: clock, lifetime: lifetimes[n], killed: make(chan struct{})}, nil
		}
		cancel()
		return last, nil
	}}
	return l, last
}

// runWithTimeout Run'ni ishga tushiradi va qaytishini kutadi (osilib qolsa test yiqiladi).
func runWithTimeout(t *testing.T, ctx context.Context, s *Supervisor) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run qaytmadi")
	}
}

func secs(ns ...int) []time.Duration {
	out := make([]time.Duration, len(ns))
	for i, n := range ns {
		out[i] = time.Duration(n) * time.Second
	}
	return out
}

func TestSupervisorRestartsAfterExit(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l, _ := scripted(clock, cancel, 0, 0)

	s := NewSupervisor("companion", l, clock)
	runWithTimeout(t, ctx, s)

	if got := l.count(); got != 3 {
		t.Fatalf("Start soni = %d, kutilgan 3 (2 marta qayta ishga tushirish)", got)
	}
	if got := clock.recorded(); !slices.Equal(got, secs(1, 2)) {
		t.Fatalf("kutishlar = %v", got)
	}
}

func TestSupervisorBacksOffOnCrashLoop(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l, _ := scripted(clock, cancel, 0, 0, 0, 0, 0)

	runWithTimeout(t, ctx, NewSupervisor("companion", l, clock))

	if got := clock.recorded(); !slices.Equal(got, secs(1, 2, 4, 8, 16)) {
		t.Fatalf("kutishlar = %v, kutilgan 1,2,4,8,16 s", got)
	}
}

func TestSupervisorCapsBackoffAt30s(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l, _ := scripted(clock, cancel, 0, 0, 0, 0, 0, 0, 0, 0)

	runWithTimeout(t, ctx, NewSupervisor("companion", l, clock))

	if got := clock.recorded(); !slices.Equal(got, secs(1, 2, 4, 8, 16, 30, 30, 30)) {
		t.Fatalf("kutishlar = %v", got)
	}
}

func TestSupervisorResetsBackoffAfterStableRun(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// 3 tez yiqilish, 10 s ish (ishga tushib olgan: nollanadi), yana 2 tez yiqilish.
	l, _ := scripted(clock, cancel, 0, 0, 0, 10*time.Second, 0, 0)

	runWithTimeout(t, ctx, NewSupervisor("companion", l, clock))

	if got := clock.recorded(); !slices.Equal(got, secs(1, 2, 4, 1, 2, 4)) {
		t.Fatalf("kutishlar = %v", got)
	}
}

// O'quvchi Companion'ni har 10 s da o'ldiradi: har qayta ishga tushish 1 s dan keyin (≤ 3 s talabi), kutish oshmaydi.
func TestRepeatedKillsRestartWithinOneSecond(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l, _ := scripted(clock, cancel, 10*time.Second, 10*time.Second, 10*time.Second, 10*time.Second, 10*time.Second,
		10*time.Second, 10*time.Second, 10*time.Second)

	runWithTimeout(t, ctx, NewSupervisor("companion", l, clock))

	if got := clock.recorded(); !slices.Equal(got, secs(1, 1, 1, 1, 1, 1, 1, 1)) {
		t.Fatalf("kutishlar = %v, har biri 1 s bo'lishi kerak", got)
	}
}

// Chegara: 4.9 s ish hali yiqilish (kutish oshadi), aynan 5 s ish ishga tushib olgan (nollanadi).
func TestSupervisorStartupCrashWindowBoundary(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l, _ := scripted(clock, cancel, 0, 0, 4900*time.Millisecond, StartupCrashWindow, 0)

	runWithTimeout(t, ctx, NewSupervisor("companion", l, clock))

	if got := clock.recorded(); !slices.Equal(got, secs(1, 2, 4, 1, 2)) {
		t.Fatalf("kutishlar = %v", got)
	}
}

func TestSupervisorBacksOffWhenStartFails(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l := &fakeLauncher{step: func(n int) (Proc, error) {
		if n == 3 {
			cancel()
		}
		return nil, errors.New("sessiya yo'q")
	}}

	s := NewSupervisor("companion", l, clock)
	runWithTimeout(t, ctx, s)

	if got := clock.recorded(); !slices.Equal(got, secs(1, 2, 4)) {
		t.Fatalf("kutishlar = %v", got)
	}
	if got := s.State(); got != StateStopped {
		t.Fatalf("State = %q", got)
	}
}

func TestSupervisorKeepsLastStartError(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errNoUser := errors.New("sessiyada foydalanuvchi yo'q")
	l := &fakeLauncher{step: func(n int) (Proc, error) {
		if n == 1 {
			cancel()
		}
		return nil, errNoUser
	}}
	s := NewSupervisor("companion", l, clock)
	if err := s.LastError(); err != nil {
		t.Fatalf("Run'dan oldin LastError = %v", err)
	}

	runWithTimeout(t, ctx, s)

	if err := s.LastError(); !errors.Is(err, errNoUser) {
		t.Fatalf("LastError = %v", err)
	}
}

func TestSupervisorKeepsLastWaitErrorAndNilProc(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var s *Supervisor
	var seenWaitErr error
	l := &fakeLauncher{step: func(n int) (Proc, error) {
		if n == 0 {
			return &fakeProc{clock: clock, killed: make(chan struct{})}, nil // Wait "exit status 1" qaytaradi
		}
		seenWaitErr = s.LastError()
		cancel()
		return nil, nil
	}}
	s = NewSupervisor("companion", l, clock)

	runWithTimeout(t, ctx, s)

	if seenWaitErr == nil || seenWaitErr.Error() != "exit status 1" {
		t.Fatalf("Wait xatosi saqlanmadi: %v", seenWaitErr)
	}
	if err := s.LastError(); !errors.Is(err, errNilProc) {
		t.Fatalf("LastError = %v", err)
	}
}

func TestSupervisorReturnsWhenKillFails(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errDenied := errors.New("access denied")
	// Kill xato beradi, Wait hech qachon qaytmaydi.
	proc := &fakeProc{clock: clock, forever: true, killErr: errDenied, killed: make(chan struct{})}
	l := &fakeLauncher{step: func(int) (Proc, error) {
		cancel()
		return proc, nil
	}}
	s := NewSupervisor("guard", l, clock)

	runWithTimeout(t, ctx, s)

	if got := proc.killCount(); got != 1 {
		t.Fatalf("Kill soni = %d", got)
	}
	if err := s.LastError(); !errors.Is(err, errDenied) {
		t.Fatalf("LastError = %v", err)
	}
	if got := s.State(); got != StateStopped {
		t.Fatalf("State = %q", got)
	}
}

func TestSupervisorStopsOnCancel(t *testing.T) {
	clock := newFakeClock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc := &fakeProc{clock: clock, forever: true, killed: make(chan struct{})}
	started := make(chan struct{})
	l := &fakeLauncher{step: func(int) (Proc, error) {
		close(started)
		return proc, nil
	}}
	s := NewSupervisor("guard", l, clock)
	if got := s.State(); got != StateStopped {
		t.Fatalf("Run'dan oldin State = %q", got)
	}

	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()
	<-started
	waitState(t, s, StateRunning)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run bekor qilingach qaytmadi")
	}

	if got := proc.killCount(); got != 1 {
		t.Fatalf("Kill soni = %d, kutilgan 1", got)
	}
	if got := s.State(); got != StateStopped {
		t.Fatalf("State = %q", got)
	}
	if got := l.count(); got != 1 {
		t.Fatalf("bekor qilingach qayta ishga tushirildi: Start soni = %d", got)
	}
}

func TestSupervisorStopsWhileRestarting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Haqiqiy soat: 1 s kutish bekor qilish bilan darhol uzilishi kerak.
	l := &fakeLauncher{step: func(int) (Proc, error) { return nil, errors.New("sessiya yo'q") }}
	s := NewSupervisor("companion", l, SystemClock{})

	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()
	waitState(t, s, StateRestarting)
	begin := time.Now()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run kutish paytida bekor qilingach qaytmadi")
	}
	if elapsed := time.Since(begin); elapsed > 500*time.Millisecond {
		t.Fatalf("bekor qilish %v kechikdi", elapsed)
	}
	if got := s.State(); got != StateStopped {
		t.Fatalf("State = %q", got)
	}
}

func TestSupervisorStopsImmediatelyIfAlreadyCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	l := &fakeLauncher{step: func(int) (Proc, error) { t.Fatal("Start chaqirilmasligi kerak"); return nil, nil }}
	s := NewSupervisor("companion", l, newFakeClock())
	runWithTimeout(t, ctx, s)
	if got := s.State(); got != StateStopped {
		t.Fatalf("State = %q", got)
	}
}

func TestSystemClockSleep(t *testing.T) {
	var c SystemClock
	if err := c.Sleep(context.Background(), 10*time.Millisecond); err != nil {
		t.Fatalf("Sleep: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	begin := time.Now()
	if err := c.Sleep(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("Sleep bekor qilingan ctx bilan: %v", err)
	}
	if time.Since(begin) > time.Second {
		t.Fatal("Sleep bekor qilingan ctx bilan kutib qoldi")
	}
}

func waitState(t *testing.T, s *Supervisor, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for s.State() != want {
		if time.Now().After(deadline) {
			t.Fatalf("State %q bo'lmadi (hozir %q)", want, s.State())
		}
		time.Sleep(time.Millisecond)
	}
}
