package guard

import (
	"context"
	"io"
	"sync"
	"time"
)

// Listener xizmat tomonida guard ulanishini kutadi. Accept ctx bekor qilinsa ctx.Err() bilan qaytadi.
// Link oldingi ulanishni yopmaguncha keyingi Accept'ni chaqirmaydi (pipe'da bitta nusxa).
type Listener interface {
	Accept(ctx context.Context) (io.ReadWriteCloser, error)
}

// Link xizmat tomonidagi guard ulanishi: bloklash holatini guard'ga yetkazadi va guard'ning hook holatini saqlaydi.
// Set va Hook istalgan goroutine'dan xavfsiz; Run bitta goroutine'da ishlaydi.
type Link struct {
	l Listener
	// Nol qiymatlar standartni bildiradi (Heartbeat, StaleAfter, RetryDelay). Run'dan oldin o'rnatiladi.
	Heartbeat  time.Duration
	StaleAfter time.Duration
	RetryDelay time.Duration

	mu        sync.Mutex
	locked    bool
	connected bool
	reported  bool   // ulangan guard kamida bitta hisobot yuborgan
	hook      string // ulangan guard'ning oxirgi hisoboti
	lastErr   error  // oxirgi Accept xatosi; muvaffaqiyatli Accept tozalaydi
	wake      chan struct{}
}

func NewLink(l Listener) *Link {
	return &Link{l: l, hook: HookOff, wake: make(chan struct{}, 1)}
}

// Set bloklash holatini o'rnatadi; o'zgargan bo'lsa ulangan guard'ga darhol yuboriladi.
func (k *Link) Set(locked bool) {
	k.mu.Lock()
	changed := k.locked != locked
	k.locked = locked
	k.mu.Unlock()
	if changed {
		select {
		case k.wake <- struct{}{}:
		default:
		}
	}
}

// Hook guard'ning hook holati. Guard ulanmagan yoki ulangan, lekin hali birinchi hisobotini yubormagan bo'lsa:
// bloklash paytida `failed` (hook hali o'rnatilmagan), aks holda `off`. Hisobot kelgach — guard'ning oxirgi hisoboti.
func (k *Link) Hook() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.connected || !k.reported {
		if k.locked {
			return HookFailed
		}
		return HookOff
	}
	return k.hook
}

// LastError oxirgi Accept xatosi (masalan, pipe yaratilmadi); guard ulangan bo'lsa nil. Xizmat uni holat
// hisobotiga yozadi: aks holda xato jim takrorlanaveradi.
func (k *Link) LastError() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.lastErr
}

func (k *Link) current() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.locked
}

// setConn ulanish holatini yangilaydi. reported: hook guard'ning hisobotidan olinganmi (ulanish/uzilishda false).
func (k *Link) setConn(connected, reported bool, hook string) {
	k.mu.Lock()
	k.connected, k.reported, k.hook = connected, reported, hook
	k.mu.Unlock()
}

// Run ctx bekor qilinguncha guard ulanishlarini birma-bir qabul qiladi va ularga xizmat qiladi.
func (k *Link) Run(ctx context.Context) {
	for ctx.Err() == nil {
		conn, err := k.l.Accept(ctx)
		if ctx.Err() == nil {
			k.mu.Lock()
			k.lastErr = err
			k.mu.Unlock()
		}
		if err != nil {
			if sleep(ctx, or(k.RetryDelay, RetryDelay)) != nil {
				return
			}
			continue
		}
		k.serve(ctx, conn)
	}
}

// serve bitta guard ulanishiga xizmat qiladi: ulanishda, har o'zgarishda va har Heartbeat'da holatni yuboradi.
// Yozish/o'qish xatosi, noto'g'ri hisobot yoki StaleAfter davomida jimlik ulanishni yopadi.
func (k *Link) serve(ctx context.Context, conn io.ReadWriteCloser) {
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	defer conn.Close()
	k.setConn(true, false, HookOff)
	defer k.setConn(false, false, HookOff)

	done := make(chan struct{})
	defer close(done)
	reports := make(chan Report)
	errc := make(chan error, 1)
	go readLoop(conn, DecodeReport, reports, errc, done)

	heartbeat := time.NewTicker(or(k.Heartbeat, Heartbeat))
	defer heartbeat.Stop()
	staleAfter := or(k.StaleAfter, StaleAfter)
	stale := time.NewTimer(staleAfter)
	defer stale.Stop()

	send := func() bool {
		_, err := conn.Write(EncodeCommand(Command{Locked: k.current()}))
		return err == nil
	}
	if !send() {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-errc:
			return
		case <-stale.C:
			return
		case r := <-reports:
			stale.Reset(staleAfter)
			k.setConn(true, true, r.Hook)
		case <-k.wake:
			if !send() {
				return
			}
		case <-heartbeat.C:
			if !send() {
				return
			}
		}
	}
}
