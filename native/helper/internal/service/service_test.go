package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

// --- soxta portlar ---

type fakeClock struct{ t time.Duration }

func (c *fakeClock) Uptime() time.Duration { return c.t }

// fakeHub lock-state javobini va yuborilgan status hisobotlarini saqlaydi.
type fakeHub struct {
	state    hub.LockState
	stateErr error
	polls    int
	reports  []hub.Status
	reportFn func() error
}

func (h *fakeHub) LockState(context.Context) (hub.LockState, error) {
	h.polls++
	return h.state, h.stateErr
}

func (h *fakeHub) ReportStatus(_ context.Context, s hub.Status) error {
	if h.reportFn != nil {
		if err := h.reportFn(); err != nil {
			return err
		}
	}
	h.reports = append(h.reports, s)
	return nil
}

func (h *fakeHub) lock(lease int) {
	seq := "1"
	h.state = hub.LockState{Locked: true, Sequence: &seq, LeaseSeconds: lease}
}

func (h *fakeHub) unlock() { h.state = hub.LockState{LeaseSeconds: 120} }

// fakeLock lock.Lock semantikasining soddalashtirilgani: lease uptime bilan, Tick muddati o'tganini tushiradi.
type fakeLock struct {
	clock    *fakeClock
	locked   bool
	deadline time.Duration
	ticks    int
	restored bool
}

func (l *fakeLock) Apply(s hub.LockState) {
	if !s.Locked {
		l.locked = false
		return
	}
	l.locked = true
	l.deadline = l.clock.t + time.Duration(s.LeaseSeconds)*time.Second
}

func (l *fakeLock) Tick() {
	l.ticks++
	if l.locked && l.clock.t >= l.deadline {
		l.locked = false
	}
}

func (l *fakeLock) Locked() bool    { return l.locked }
func (l *fakeLock) Restore()        { l.restored = true }
func (l *fakeLock) StoreErr() error { return nil }

type fakePolicy struct {
	applied  []string
	restores int
	pending  bool
	applyErr error
}

func (p *fakePolicy) Apply(sid string) error {
	p.applied = append(p.applied, sid)
	p.pending = true
	return p.applyErr
}

func (p *fakePolicy) Restore() error {
	p.restores++
	p.pending = false
	return nil
}

func (p *fakePolicy) Pending() bool { return p.pending }

type fakeGuard struct {
	locked bool
	sets   []bool
}

func (g *fakeGuard) Set(locked bool) { g.locked = locked; g.sets = append(g.sets, locked) }
func (g *fakeGuard) Hook() string {
	if g.locked {
		return hub.ComponentActive
	}
	return hub.ComponentOff
}
func (g *fakeGuard) LastError() error { return nil }

type fakeProcGuard struct {
	running bool
	starts  []uint32
	stops   int
}

func (p *fakeProcGuard) Start(session uint32) error {
	p.running = true
	p.starts = append(p.starts, session)
	return nil
}
func (p *fakeProcGuard) Stop() { p.running = false; p.stops++ }
func (p *fakeProcGuard) State() string {
	if p.running {
		return hub.ComponentActive
	}
	return hub.ComponentOff
}
func (p *fakeProcGuard) Stats() (uint64, uint64, error) { return 0, 0, nil }

type fakeCAD struct {
	state   string
	sets    []bool
	started bool
	probed  bool
	pending bool
	retries int
	// setCtxErr Set'ga kelgan ctx'ning holati (to'xtatishda yangi ctx tekshiruvi uchun).
	setCtxErr []error
}

func (c *fakeCAD) Start(context.Context) { c.started = true }
func (c *fakeCAD) Probe()                { c.probed = true }
func (c *fakeCAD) Set(ctx context.Context, locked bool) string {
	c.sets = append(c.sets, locked)
	c.setCtxErr = append(c.setCtxErr, ctx.Err())
	c.state = hub.CADOff
	if locked {
		c.state = hub.CADBlocked
	}
	return c.state
}
func (c *fakeCAD) Pending() bool         { return c.pending }
func (c *fakeCAD) Retry(context.Context) { c.retries++; c.pending = false }
func (c *fakeCAD) State() string         { return c.state }
func (c *fakeCAD) Reason() string        { return "" }

// fakeChild Supervisor'lar ko'chirilgan sessiyalarni yozadi.
type fakeChild struct {
	moves []string
	state string
}

func (c *fakeChild) Move(s Session, ok bool) {
	if ok {
		c.moves = append(c.moves, s.UserSID)
		c.state = "running"
	} else {
		c.moves = append(c.moves, "-")
		c.state = "stopped"
	}
}
func (c *fakeChild) State() string    { return c.state }
func (c *fakeChild) LastError() error { return nil }

type fakeMesh struct {
	state  string
	checks int
}

func (m *fakeMesh) Check() (string, error) { m.checks++; return m.state, nil }

type fakeSessions struct {
	s   Session
	ok  bool
	err error
}

func (f *fakeSessions) ActiveConsole() (Session, bool, error) { return f.s, f.ok, f.err }

type fakeShell struct{ ensured []string }

func (f *fakeShell) Ensure(s Session) error { f.ensured = append(f.ensured, s.UserSID); return nil }

type logRecorder struct {
	mu    sync.Mutex
	lines []string
}

func (l *logRecorder) log(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logRecorder) count(sub string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, line := range l.lines {
		if strings.Contains(line, sub) {
			n++
		}
	}
	return n
}

// --- harness ---

const (
	sidA = "S-1-5-21-1-2-3-1001"
	sidB = "S-1-5-21-1-2-3-1002"
)

type harness struct {
	t         *testing.T
	ctx       context.Context
	clock     *fakeClock
	hub       *fakeHub
	lock      *fakeLock
	policy    *fakePolicy
	guard     *fakeGuard
	procGuard *fakeProcGuard
	cad       *fakeCAD
	companion *fakeChild
	guardProc *fakeChild
	mesh      *fakeMesh
	sessions  *fakeSessions
	shell     *fakeShell
	logs      *logRecorder
	svc       *Service
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	clock := &fakeClock{t: time.Hour}
	h := &harness{
		t: t, ctx: context.Background(), clock: clock,
		hub:       &fakeHub{state: hub.LockState{LeaseSeconds: 120}},
		lock:      &fakeLock{clock: clock},
		policy:    &fakePolicy{},
		guard:     &fakeGuard{},
		procGuard: &fakeProcGuard{},
		cad:       &fakeCAD{state: hub.CADOff},
		companion: &fakeChild{state: "stopped"},
		guardProc: &fakeChild{state: "stopped"},
		mesh:      &fakeMesh{state: hub.MeshAgentRunning},
		sessions:  &fakeSessions{s: Session{ID: 2, UserSID: sidA}, ok: true},
		shell:     &fakeShell{},
		logs:      &logRecorder{},
	}
	h.svc = New(Deps{
		Hub: h.hub, Lock: h.lock, Policy: h.policy, Guard: h.guard, ProcGuard: h.procGuard, CAD: h.cad,
		Companion: h.companion, GuardProc: h.guardProc, Mesh: h.mesh, Sessions: h.sessions, Shell: h.shell,
		Clock: clock, Log: h.logs.log, Version: "test",
	})
	h.svc.Start(h.ctx)
	return h
}

// step bir soniya o'tkazib Step'ni chaqiradi (birinchisi vaqtni surmaydi).
func (h *harness) steps(n int) {
	for range n {
		h.svc.Step(h.ctx)
		h.clock.t += time.Second
	}
}

func (h *harness) lastReport() hub.Status {
	h.t.Helper()
	if len(h.hub.reports) == 0 {
		h.t.Fatal("status hisoboti yuborilmagan")
	}
	return h.hub.reports[len(h.hub.reports)-1]
}

// --- testlar ---

func TestStartRestoresAndProbes(t *testing.T) {
	h := newHarness(t)
	if !h.lock.restored || !h.cad.started || !h.cad.probed {
		t.Fatalf("Start: lock.Restore=%v cad.Start=%v cad.Probe=%v", h.lock.restored, h.cad.started, h.cad.probed)
	}
	h.steps(1)
	if got := h.companion.moves; !slices.Equal(got, []string{sidA}) {
		t.Fatalf("Companion birinchi Step'da sessiyaga ko'chirilmadi: %v", got)
	}
	if got := h.guardProc.moves; !slices.Equal(got, []string{sidA}) {
		t.Fatalf("guard birinchi Step'da sessiyaga ko'chirilmadi: %v", got)
	}
	if h.mesh.checks != 1 {
		t.Fatalf("MeshAgent tekshiruvlari = %d", h.mesh.checks)
	}
}

func TestStartRestoresLeftoverPolicyWhenUnlocked(t *testing.T) {
	clock := &fakeClock{t: time.Hour}
	p := &fakePolicy{pending: true}
	svc := New(Deps{
		Hub: &fakeHub{state: hub.LockState{LeaseSeconds: 120}}, Lock: &fakeLock{clock: clock}, Policy: p,
		Guard: &fakeGuard{}, ProcGuard: &fakeProcGuard{}, CAD: &fakeCAD{}, Companion: &fakeChild{},
		GuardProc: &fakeChild{}, Mesh: &fakeMesh{}, Sessions: &fakeSessions{}, Shell: &fakeShell{}, Clock: clock,
	})
	svc.Start(context.Background())
	if p.restores != 1 {
		t.Fatalf("ishga tushishda qoldiq siyosat tiklanmadi: restores=%d", p.restores)
	}
}

func TestLockEngagesAllComponents(t *testing.T) {
	h := newHarness(t)
	h.steps(1)
	h.hub.lock(120)
	h.steps(5) // keyingi hub so'rovi 5 s ichida
	if !h.lock.locked {
		t.Fatal("lock qo'llanmadi")
	}
	if !slices.Equal(h.policy.applied, []string{sidA}) {
		t.Fatalf("Policy.Apply = %v", h.policy.applied)
	}
	if !h.guard.locked {
		t.Fatal("guard'ga bloklash yuborilmadi")
	}
	if !slices.Equal(h.procGuard.starts, []uint32{2}) {
		t.Fatalf("ProcGuard.Start = %v", h.procGuard.starts)
	}
	if !slices.Equal(h.cad.sets, []bool{true}) {
		t.Fatalf("CAD.Set = %v", h.cad.sets)
	}
	st := h.lastReport()
	want := hub.Status{Version: "test", Hook: "active", Policy: "active", ProcessGuard: "active", CAD: "blocked",
		Companion: "running", MeshAgent: "running"}
	if st != want {
		t.Fatalf("status = %+v, kutilgan %+v", st, want)
	}
}

func TestUnlockReleasesAllComponents(t *testing.T) {
	h := newHarness(t)
	h.hub.lock(120)
	h.steps(2)
	h.hub.unlock()
	h.steps(6)
	if h.lock.locked {
		t.Fatal("lock tushmadi")
	}
	if h.guard.locked || h.procGuard.running || h.procGuard.stops == 0 {
		t.Fatalf("guard=%v procguard=%v stops=%d", h.guard.locked, h.procGuard.running, h.procGuard.stops)
	}
	if h.policy.restores == 0 || h.policy.pending {
		t.Fatalf("siyosat tiklanmadi: restores=%d pending=%v", h.policy.restores, h.policy.pending)
	}
	if !slices.Equal(h.cad.sets, []bool{true, false}) {
		t.Fatalf("CAD.Set = %v", h.cad.sets)
	}
	if !slices.Equal(h.shell.ensured, []string{sidA}) {
		t.Fatalf("ochilgach explorer tekshirilmadi: %v", h.shell.ensured)
	}
	st := h.lastReport()
	if st.Hook != "off" || st.Policy != "off" || st.ProcessGuard != "off" || st.CAD != "off" {
		t.Fatalf("ochiq status = %+v", st)
	}
}

// Hub yo'qolsa lease Step'dagi Tick bilan tugaydi: hub so'rovi muvaffaqiyatsiz bo'lsa ham.
func TestHubLossReleasesAfterLease(t *testing.T) {
	h := newHarness(t)
	h.hub.lock(10)
	h.steps(1)
	if !h.lock.locked {
		t.Fatal("lock qo'llanmadi")
	}
	h.hub.stateErr = errors.New("hub javob bermadi")
	h.steps(9)
	if !h.lock.locked {
		t.Fatal("lease tugashidan oldin lock tushdi")
	}
	h.steps(2)
	if h.lock.locked || h.guard.locked || h.procGuard.running {
		t.Fatalf("lease tugagach ochilmadi: lock=%v guard=%v procguard=%v", h.lock.locked, h.guard.locked, h.procGuard.running)
	}
	if h.lock.ticks < 11 {
		t.Fatalf("Tick har Step'da chaqirilmadi: %d", h.lock.ticks)
	}
	if n := h.logs.count("hub javob bermadi"); n != 1 {
		t.Fatalf("hub xatosi %d marta yozildi (o'zgarganda bir marta kutilgan)", n)
	}
}

func TestDriftIsReapplied(t *testing.T) {
	h := newHarness(t)
	h.hub.lock(120)
	h.steps(1)
	if len(h.policy.applied) != 1 {
		t.Fatalf("Apply = %v", h.policy.applied)
	}
	h.steps(10)
	if len(h.policy.applied) != 2 {
		t.Fatalf("10 s dan keyin siyosat qayta qo'llanmadi: %v", h.policy.applied)
	}
	h.steps(10)
	if len(h.policy.applied) != 3 {
		t.Fatalf("20 s dan keyin: %v", h.policy.applied)
	}
	// CAD va ProcGuard drift'da qayta yoqilmaydi.
	if len(h.cad.sets) != 1 || len(h.procGuard.starts) != 1 {
		t.Fatalf("CAD.Set=%v ProcGuard.Start=%v", h.cad.sets, h.procGuard.starts)
	}
}

func TestSessionChangeMovesPolicy(t *testing.T) {
	h := newHarness(t)
	h.hub.lock(120)
	h.steps(1)
	h.sessions.s = Session{ID: 3, UserSID: sidB}
	h.svc.NotifySessionChange()
	h.steps(1)
	if !slices.Equal(h.policy.applied, []string{sidA, sidB}) {
		t.Fatalf("Policy.Apply = %v", h.policy.applied)
	}
	if !slices.Equal(h.procGuard.starts, []uint32{2, 3}) || h.procGuard.stops == 0 {
		t.Fatalf("ProcGuard.Start = %v stops=%d", h.procGuard.starts, h.procGuard.stops)
	}
	if !slices.Equal(h.companion.moves, []string{sidA, sidB}) || !slices.Equal(h.guardProc.moves, []string{sidA, sidB}) {
		t.Fatalf("Companion=%v guard=%v", h.companion.moves, h.guardProc.moves)
	}
	// Foydalanuvchi chiqdi: Supervisor'lar to'xtaydi, ProcGuard o'chadi, siyosat yangi SID'siz qo'llanmaydi.
	h.sessions.ok = false
	h.svc.NotifySessionChange()
	h.steps(1)
	if h.procGuard.running {
		t.Fatal("sessiya yo'q, ProcGuard ishlayapti")
	}
	if got := h.companion.moves[len(h.companion.moves)-1]; got != "-" {
		t.Fatalf("Companion to'xtatilmadi: %v", h.companion.moves)
	}
	if st := h.lastReport(); st.Companion != hub.CompanionNoSession {
		t.Fatalf("companion status = %q", st.Companion)
	}
}

// Bildirishnoma kelmasa ham sessiya muntazam tekshiriladi.
func TestSessionChangeIsPolledWithoutNotification(t *testing.T) {
	h := newHarness(t)
	h.steps(1)
	h.sessions.s = Session{ID: 3, UserSID: sidB}
	h.steps(int(SessionPollInterval/time.Second) + 1)
	if !slices.Equal(h.companion.moves, []string{sidA, sidB}) {
		t.Fatalf("Companion = %v", h.companion.moves)
	}
}

func TestSessionChangeRestoresLeftoverPolicyWhenUnlocked(t *testing.T) {
	h := newHarness(t)
	h.steps(1)
	h.policy.pending = true
	before := h.policy.restores
	h.sessions.s = Session{ID: 3, UserSID: sidB}
	h.svc.NotifySessionChange()
	h.steps(1)
	if h.policy.restores != before+1 {
		t.Fatalf("logon'da qoldiq tiklanmadi: %d -> %d", before, h.policy.restores)
	}
}

func TestPendingCleanupIsRetriedWhileUnlocked(t *testing.T) {
	h := newHarness(t)
	h.steps(1)
	h.policy.pending = true
	h.cad.pending = true
	restores, retries := h.policy.restores, h.cad.retries
	h.steps(30)
	if h.policy.restores != restores+1 || h.cad.retries != retries+1 {
		t.Fatalf("30 s da: restores %d->%d, cad retries %d->%d", restores, h.policy.restores, retries, h.cad.retries)
	}
}

func TestStatusReportedOnChange(t *testing.T) {
	h := newHarness(t)
	h.steps(1)
	if len(h.hub.reports) != 1 {
		t.Fatalf("birinchi Step'da hisobot = %d", len(h.hub.reports))
	}
	h.steps(10)
	if len(h.hub.reports) != 1 {
		t.Fatalf("o'zgarishsiz qayta yuborildi: %d", len(h.hub.reports))
	}
	h.mesh.state = hub.MeshAgentRestarted
	h.steps(int(MeshInterval / time.Second))
	if len(h.hub.reports) != 2 || h.lastReport().MeshAgent != hub.MeshAgentRestarted {
		t.Fatalf("o'zgarish yuborilmadi: %+v", h.hub.reports)
	}
	// O'zgarishsiz ham har 30 s.
	n := len(h.hub.reports)
	h.steps(int(StatusInterval/time.Second) + 1)
	if len(h.hub.reports) <= n {
		t.Fatal("30 s da davriy hisobot yuborilmadi")
	}
}

func TestFailedReportIsRetried(t *testing.T) {
	h := newHarness(t)
	fail := true
	h.hub.reportFn = func() error {
		if fail {
			return errors.New("ulanish yo'q")
		}
		return nil
	}
	h.steps(1)
	if len(h.hub.reports) != 0 {
		t.Fatal("yiqilgan hisobot saqlandi")
	}
	fail = false
	h.steps(int(HubPollInterval/time.Second) + 1)
	if len(h.hub.reports) != 1 {
		t.Fatalf("yiqilgan hisobot qayta yuborilmadi: %d", len(h.hub.reports))
	}
}

// Policy.Apply xatosi (masalan, eski foydalanuvchi qoldig'i tiklanmadi) lock'ni bekor qilmaydi: boshqa komponentlar
// yoqiladi, siyosat `failed` deb hisobot qilinadi va xato jurnalga bir marta yoziladi.
func TestPolicyErrorKeepsLockEngaged(t *testing.T) {
	h := newHarness(t)
	h.policy.applyErr = errors.New("hive yuklanmagan")
	h.hub.lock(120)
	h.steps(12)
	if !h.guard.locked || !h.procGuard.running || h.cad.state != hub.CADBlocked {
		t.Fatalf("guard=%v procguard=%v cad=%v", h.guard.locked, h.procGuard.running, h.cad.state)
	}
	if st := h.lastReport(); st.Policy != hub.ComponentFailed {
		t.Fatalf("policy status = %q", st.Policy)
	}
	if n := h.logs.count("hive yuklanmagan"); n != 1 {
		t.Fatalf("siyosat xatosi %d marta yozildi", n)
	}
}

func TestStopReleasesWithFreshContext(t *testing.T) {
	h := newHarness(t)
	h.hub.lock(120)
	h.steps(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h.ctx = ctx
	h.svc.Stop()
	if h.guard.locked || h.procGuard.running {
		t.Fatal("to'xtatishda guard/procguard o'chmadi")
	}
	if h.policy.pending {
		t.Fatal("to'xtatishda siyosat tiklanmadi")
	}
	last := len(h.cad.sets) - 1
	if h.cad.sets[last] || h.cad.setCtxErr[last] != nil {
		t.Fatalf("CAD.Set(false) yangi ctx bilan chaqirilmadi: sets=%v ctxErr=%v", h.cad.sets, h.cad.setCtxErr)
	}
	if got := h.companion.moves[len(h.companion.moves)-1]; got != "-" {
		t.Fatalf("Companion to'xtatilmadi: %v", h.companion.moves)
	}
}
