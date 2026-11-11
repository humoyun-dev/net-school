package guard

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// Testlarda vaqtlar qisqa: holat mashinasi bir xil, faqat kutish kamroq.
const (
	testRetry     = 20 * time.Millisecond
	testStale     = 300 * time.Millisecond
	testHeartbeat = 30 * time.Millisecond
	waitLimit     = 3 * time.Second
)

func TestProtocolRoundTrip(t *testing.T) {
	for _, locked := range []bool{true, false} {
		line := EncodeCommand(Command{Locked: locked})
		want := `{"locked":false}` + "\n"
		if locked {
			want = `{"locked":true}` + "\n"
		}
		if string(line) != want {
			t.Fatalf("EncodeCommand(%v) = %q, kutilgan %q", locked, line, want)
		}
		got, err := DecodeCommand(line)
		if err != nil || got.Locked != locked {
			t.Fatalf("DecodeCommand(%q) = %+v, %v", line, got, err)
		}
	}
	for _, hook := range []string{HookActive, HookOff, HookFailed} {
		line, err := EncodeReport(Report{Hook: hook})
		if err != nil {
			t.Fatalf("EncodeReport(%q): %v", hook, err)
		}
		if want := `{"hook":"` + hook + `"}` + "\n"; string(line) != want {
			t.Fatalf("EncodeReport(%q) = %q, kutilgan %q", hook, line, want)
		}
		got, err := DecodeReport(line)
		if err != nil || got.Hook != hook {
			t.Fatalf("DecodeReport(%q) = %+v, %v", line, got, err)
		}
	}
}

func TestProtocolRejectsMalformedLines(t *testing.T) {
	for _, line := range []string{
		`{}`,
		`{"locked":null}`,
		`{"locked":"true"}`,
		`{"locked":true,"extra":1}`,
		`{"locked":true}{"locked":false}`,
		`not json`,
	} {
		if c, err := DecodeCommand([]byte(line)); err == nil {
			t.Errorf("DecodeCommand(%q) = %+v, xato kutilgan", line, c)
		}
	}
	for _, line := range []string{`{}`, `{"hook":"on"}`, `{"hook":""}`, `{"hook":"active","x":1}`} {
		if r, err := DecodeReport([]byte(line)); err == nil {
			t.Errorf("DecodeReport(%q) = %+v, xato kutilgan", line, r)
		}
	}
	if _, err := EncodeReport(Report{Hook: "on"}); err == nil {
		t.Error("EncodeReport noma'lum holatni qabul qildi")
	}
	// Juda uzun qator xotirani to'ldirmasin: o'quvchi uni rad etadi.
	r := bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", 4*maxLine)+"\n"), maxLine)
	if _, err := readLine(r); err == nil {
		t.Error("readLine juda uzun qatorni qabul qildi")
	}
}

// fakeHook guard'ning soxta hook'i: o'rnatishlar soni va hozirgi holat.
type fakeHook struct {
	mu        sync.Mutex
	installed bool
	installs  int
	removes   int
	fail      error
}

func (h *fakeHook) Install() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fail != nil {
		return h.fail
	}
	h.installed = true
	h.installs++
	return nil
}

func (h *fakeHook) Uninstall() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.installed = false
	h.removes++
}

func (h *fakeHook) snapshot() (installed bool, installs, removes int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.installed, h.installs, h.removes
}

// fakeService guard ulanadigan "xizmat" tomoni: har Dial yangi net.Pipe juftini beradi.
type fakeService struct {
	conns chan net.Conn
	dials chan struct{}
}

func newFakeService() *fakeService {
	return &fakeService{conns: make(chan net.Conn, 8), dials: make(chan struct{}, 8)}
}

func (s *fakeService) dial(context.Context) (io.ReadWriteCloser, error) {
	server, client := net.Pipe()
	s.conns <- server
	s.dials <- struct{}{}
	return client, nil
}

func (s *fakeService) next(t *testing.T) (net.Conn, *bufio.Reader) {
	t.Helper()
	select {
	case c := <-s.conns:
		t.Cleanup(func() { _ = c.Close() })
		return c, bufio.NewReader(c)
	case <-time.After(waitLimit):
		t.Fatal("guard ulanmadi")
		return nil, nil
	}
}

func send(t *testing.T, c net.Conn, locked bool) {
	t.Helper()
	_ = c.SetWriteDeadline(time.Now().Add(waitLimit))
	if _, err := c.Write(EncodeCommand(Command{Locked: locked})); err != nil {
		t.Fatalf("buyruq yuborilmadi: %v", err)
	}
}

func receive(t *testing.T, c net.Conn, r *bufio.Reader) string {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(waitLimit))
	line, err := r.ReadBytes('\n')
	if err != nil {
		t.Fatalf("hisobot kelmadi: %v", err)
	}
	rep, err := DecodeReport(line)
	if err != nil {
		t.Fatalf("hisobot noto'g'ri: %v", err)
	}
	return rep.Hook
}

func startGuard(t *testing.T, svc *fakeService, hook *fakeHook) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	g := &Guard{Dial: svc.dial, Hook: hook, RetryDelay: testRetry, StaleAfter: testStale}
	done := make(chan error, 1)
	go func() { done <- g.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("Run = %v, kutilgan context.Canceled", err)
			}
		case <-time.After(waitLimit):
			t.Error("Run ctx bekor qilingach qaytmadi")
		}
	})
}

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

func TestGuardDropsHookWhenPipeCloses(t *testing.T) {
	svc, hook := newFakeService(), &fakeHook{}
	startGuard(t, svc, hook)

	c, r := svc.next(t)
	send(t, c, true)
	if got := receive(t, c, r); got != HookActive {
		t.Fatalf("hisobot %q, kutilgan %q", got, HookActive)
	}
	if installed, _, _ := hook.snapshot(); !installed {
		t.Fatal("locked:true dan keyin hook o'rnatilmagan")
	}

	_ = c.Close()
	eventually(t, "pipe uzilgach hook olib tashlanishi", func() bool {
		installed, _, _ := hook.snapshot()
		return !installed
	})
	// Guard qayta ulanadi va yangi ulanishda hook o'zi qaytmaydi: xizmat holatni qayta yuboradi.
	c2, r2 := svc.next(t)
	if installed, _, _ := hook.snapshot(); installed {
		t.Fatal("qayta ulanishda buyruqsiz hook o'rnatildi")
	}
	send(t, c2, true)
	if got := receive(t, c2, r2); got != HookActive {
		t.Fatalf("qayta ulanishdan keyin hisobot %q", got)
	}
}

func TestGuardRemovesHookOnUnlock(t *testing.T) {
	svc, hook := newFakeService(), &fakeHook{}
	startGuard(t, svc, hook)
	c, r := svc.next(t)

	send(t, c, false)
	if got := receive(t, c, r); got != HookOff {
		t.Fatalf("ochiq holatda hisobot %q", got)
	}
	if _, installs, _ := hook.snapshot(); installs != 0 {
		t.Fatal("locked:false hook o'rnatdi")
	}
	send(t, c, true)
	receive(t, c, r)
	send(t, c, false)
	if got := receive(t, c, r); got != HookOff {
		t.Fatalf("ochilgach hisobot %q", got)
	}
	if installed, _, _ := hook.snapshot(); installed {
		t.Fatal("locked:false dan keyin hook qoldi")
	}
}

// Windows vaqtida javob bermagan yoki secure desktop'dan keyin LL hook'ni jimgina olib tashlaydi va buni bilishning
// ishonchli yo'li yo'q: har locked:true (xizmat uni har 5 s yuboradi) hook'ni yangilaydi.
func TestGuardRefreshesHookOnEveryLockedHeartbeat(t *testing.T) {
	svc, hook := newFakeService(), &fakeHook{}
	startGuard(t, svc, hook)
	c, r := svc.next(t)
	for range 3 {
		send(t, c, true)
		receive(t, c, r)
	}
	if installed, installs, _ := hook.snapshot(); !installed || installs != 3 {
		t.Fatalf("installed=%v installs=%d, kutilgan true va 3", installed, installs)
	}
}

func TestGuardReportsFailedInstallAndRetries(t *testing.T) {
	svc, hook := newFakeService(), &fakeHook{fail: errors.New("SetWindowsHookExW: access denied")}
	startGuard(t, svc, hook)
	c, r := svc.next(t)
	send(t, c, true)
	if got := receive(t, c, r); got != HookFailed {
		t.Fatalf("hisobot %q, kutilgan %q", got, HookFailed)
	}
	hook.mu.Lock()
	hook.fail = nil
	hook.mu.Unlock()
	send(t, c, true)
	if got := receive(t, c, r); got != HookActive {
		t.Fatalf("keyingi heartbeat'da hisobot %q, kutilgan %q", got, HookActive)
	}
}

// Xizmat osilib qolsa (pipe ochiq, lekin heartbeat yo'q) o'quvchi abadiy bloklanib qolmasin.
func TestGuardDropsHookWhenServiceGoesQuiet(t *testing.T) {
	svc, hook := newFakeService(), &fakeHook{}
	startGuard(t, svc, hook)
	c, r := svc.next(t)
	send(t, c, true)
	receive(t, c, r)
	eventually(t, "heartbeat'siz hook olib tashlanishi", func() bool {
		installed, _, _ := hook.snapshot()
		return !installed
	})
	svc.next(t) // jim ulanish yopilib, guard qayta ulanadi
}

func TestGuardDropsHookOnMalformedCommand(t *testing.T) {
	svc, hook := newFakeService(), &fakeHook{}
	startGuard(t, svc, hook)
	c, r := svc.next(t)
	send(t, c, true)
	receive(t, c, r)
	_, _ = c.Write([]byte("{\"locked\":\"maybe\"}\n"))
	eventually(t, "noto'g'ri buyruqdan keyin hook olib tashlanishi", func() bool {
		installed, _, _ := hook.snapshot()
		return !installed
	})
}

// fakeListener xizmat tomoni uchun: har Accept testdan berilgan ulanishni qaytaradi.
type fakeListener struct{ conns chan io.ReadWriteCloser }

func (l *fakeListener) Accept(ctx context.Context) (io.ReadWriteCloser, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func startLink(t *testing.T) (*Link, *fakeListener) {
	t.Helper()
	l := &fakeListener{conns: make(chan io.ReadWriteCloser)}
	k := NewLink(l)
	k.Heartbeat, k.StaleAfter, k.RetryDelay = testHeartbeat, testStale, testRetry
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { k.Run(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(waitLimit):
			t.Error("Link.Run ctx bekor qilingach qaytmadi")
		}
	})
	return k, l
}

// connectGuard Link'ga "guard" ulaydi. net.Pipe buferlanmagan (haqiqiy pipe'da bufer bor): buyruqlar fon
// goroutine'ida o'qilib kanalga yoziladi, aks holda Link heartbeat yozishda to'xtab qoladi.
func connectGuard(t *testing.T, l *fakeListener) (net.Conn, <-chan bool) {
	t.Helper()
	server, client := net.Pipe()
	t.Cleanup(func() { _ = client.Close() })
	select {
	case l.conns <- server:
	case <-time.After(waitLimit):
		t.Fatal("Link Accept qilmadi")
	}
	cmds := make(chan bool, 1024)
	go func() {
		r := bufio.NewReader(client)
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			cmd, err := DecodeCommand(line)
			if err != nil {
				t.Errorf("buyruq noto'g'ri: %v", err)
				return
			}
			cmds <- cmd.Locked
		}
	}()
	return client, cmds
}

func readCommand(t *testing.T, cmds <-chan bool) bool {
	t.Helper()
	select {
	case locked := <-cmds:
		return locked
	case <-time.After(waitLimit):
		t.Fatal("buyruq kelmadi")
		return false
	}
}

func report(t *testing.T, c net.Conn, hook string) {
	t.Helper()
	line, err := EncodeReport(Report{Hook: hook})
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(waitLimit))
	if _, err := c.Write(line); err != nil {
		t.Fatalf("hisobot yuborilmadi: %v", err)
	}
}

func TestLinkSendsStateOnConnectChangeAndHeartbeat(t *testing.T) {
	k, l := startLink(t)
	k.Set(true)
	c, r := connectGuard(t, l)
	if !readCommand(t, r) {
		t.Fatal("ulanishda joriy holat (locked:true) yuborilmadi")
	}
	report(t, c, HookActive)
	eventually(t, "Hook() = active", func() bool { return k.Hook() == HookActive })
	// Heartbeat: o'zgarishsiz ham holat qayta yuboriladi.
	if !readCommand(t, r) {
		t.Fatal("heartbeat locked:true emas")
	}
	k.Set(false)
	// Navbatdagi heartbeat (true) o'zgarishdan oldin ketgan bo'lishi mumkin: false kelguncha o'qiladi.
	deadline := time.Now().Add(waitLimit)
	for readCommand(t, r) {
		if time.Now().After(deadline) {
			t.Fatal("locked:false yuborilmadi")
		}
	}
}

func TestLinkReportsMissingGuard(t *testing.T) {
	k, l := startLink(t)
	if got := k.Hook(); got != HookOff {
		t.Fatalf("guard yo'q, ochiq: Hook() = %q, kutilgan %q", got, HookOff)
	}
	k.Set(true)
	if got := k.Hook(); got != HookFailed {
		t.Fatalf("guard yo'q, bloklangan: Hook() = %q, kutilgan %q", got, HookFailed)
	}
	c, r := connectGuard(t, l)
	readCommand(t, r)
	report(t, c, HookActive)
	eventually(t, "Hook() = active", func() bool { return k.Hook() == HookActive })
	_ = c.Close()
	eventually(t, "uzilgach Hook() = failed", func() bool { return k.Hook() == HookFailed })
	// Link keyingi guard'ni qabul qiladi.
	_, r2 := connectGuard(t, l)
	if !readCommand(t, r2) {
		t.Fatal("qayta ulangan guard'ga locked:true yuborilmadi")
	}
}

// Guard osilib qolsa (javob bermasa) Link ulanishni uzadi va hook'ni failed deb biladi.
func TestLinkDropsSilentGuard(t *testing.T) {
	k, l := startLink(t)
	k.Set(true)
	c, r := connectGuard(t, l)
	readCommand(t, r)
	report(t, c, HookActive)
	eventually(t, "Hook() = active", func() bool { return k.Hook() == HookActive })
	// Guard endi javob bermaydi (buyruqlar fonda o'qilaveradi).
	eventually(t, "jim guard uzilishi", func() bool { return k.Hook() == HookFailed })
}

// Hook oqimi o'lsa guard jarayoni hook'siz tirik qolmasin: Run xato bilan qaytadi, jarayon nol bo'lmagan kod bilan
// chiqadi va Supervisor uni qayta ishga tushiradi.
func TestGuardExitsWhenHookThreadDies(t *testing.T) {
	svc, hook := newFakeService(), &fakeHook{}
	dead := make(chan struct{})
	g := &Guard{Dial: svc.dial, Hook: hook, HookDone: dead, RetryDelay: testRetry, StaleAfter: testStale}
	done := make(chan error, 1)
	go func() { done <- g.Run(context.Background()) }()
	c, r := svc.next(t)
	send(t, c, true)
	receive(t, c, r)

	close(dead)
	select {
	case err := <-done:
		if !errors.Is(err, ErrHookGone) {
			t.Fatalf("Run = %v, kutilgan ErrHookGone", err)
		}
	case <-time.After(waitLimit):
		t.Fatal("hook oqimi o'lgach Run qaytmadi")
	}
}

type failingListener struct{ err error }

func (l failingListener) Accept(context.Context) (io.ReadWriteCloser, error) { return nil, l.err }

// Accept doim yiqilsa (masalan pipe nomini boshqa jarayon egallagan) xato jim qolmasin: Task 10 uni hisobotga yozadi.
func TestLinkKeepsLastAcceptError(t *testing.T) {
	want := errors.New("pipe yaratilmadi")
	k := NewLink(failingListener{err: want})
	k.RetryDelay = testRetry
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go k.Run(ctx)
	eventually(t, "LastError = Accept xatosi", func() bool { return errors.Is(k.LastError(), want) })
}

func TestLinkClearsLastErrorOnAccept(t *testing.T) {
	k, l := startLink(t)
	if k.LastError() != nil {
		t.Fatalf("LastError = %v", k.LastError())
	}
	_, r := connectGuard(t, l)
	readCommand(t, r)
	if k.LastError() != nil {
		t.Fatalf("ulanishdan keyin LastError = %v", k.LastError())
	}
}
