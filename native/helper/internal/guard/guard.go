// Package guard o'quvchi sessiyasidagi SYSTEM jarayoni (guard) va xizmat orasidagi named pipe protokolini, guard'ning
// holat mashinasini (Guard) va xizmat tomonidagi ulanishni (Link) saqlaydi.
//
// Guard faqat past darajali klaviatura hook'ini ushlaydi: u SYSTEM tokeni bilan ishlaydi, shuning uchun o'quvchi uni
// Vazifalar menejeridan yopa olmaydi va pastroq darajadagi (o'quvchi) jarayon yuborgan soxta tugmalar
// LLKHF_LOWER_IL_INJECTED bilan keladi (keys.Policy ularni to'sadi).
//
// Protokol: qator bilan ajratilgan JSON. Xizmat → guard `{"locked":true|false}` (har o'zgarishda va har 5 s);
// guard → xizmat har buyruqqa javoban `{"hook":"active"|"off"|"failed"}`. Ikkala tomon ham jimlikni (StaleAfter)
// uzilish deb biladi: xizmat osilsa hook olib tashlanadi, guard osilsa xizmat uni `failed` deb hisoblaydi.
//
// Bu fayl toza mantiq: Windows API yo'q, har OS'da test qilinadi. Pipe va hook — pipe_windows.go, hook_windows.go.
package guard

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

const (
	// PipeName xizmat yaratadigan, guard ulanadigan pipe.
	PipeName = `\\.\pipe\netschool-helper-guard`
	// PipeSDDL pipe DACL'i: faqat SYSTEM (himoyalangan, meros olinmaydi). Administrator ham ulana olmaydi.
	PipeSDDL = "D:P(A;;GA;;;SY)"
)

// Hook holatlari (contracts'dagi helperStatusSchema `hook` maydoni bilan bir xil).
const (
	HookActive = "active"
	HookOff    = "off"
	HookFailed = "failed"
)

const (
	// Heartbeat xizmat holatni o'zgarishsiz ham shu oraliqda qayta yuboradi.
	Heartbeat = 5 * time.Second
	// StaleAfter shuncha vaqt xabar kelmasa ulanish o'lik hisoblanadi (3 ta heartbeat).
	StaleAfter = 15 * time.Second
	// RetryDelay uzilgandan keyin qayta ulanish (guard) yoki qayta qabul qilish (xizmat, xatoda) oldidan kutish.
	RetryDelay = time.Second
)

// maxLine bitta xabar qatorining yuqori chegarasi (yangi qator bilan). Haqiqiy xabarlar 20 baytdan kichik.
const maxLine = 256

// Command xizmat → guard.
type Command struct {
	Locked bool
}

// Report guard → xizmat.
type Report struct {
	Hook string
}

type wireCommand struct {
	Locked *bool `json:"locked"`
}

type wireReport struct {
	Hook string `json:"hook"`
}

// EncodeCommand buyruqni yangi qator bilan tugaydigan JSON qatoriga aylantiradi.
func EncodeCommand(c Command) []byte {
	if c.Locked {
		return []byte(`{"locked":true}` + "\n")
	}
	return []byte(`{"locked":false}` + "\n")
}

// DecodeCommand bitta qatorni o'qiydi. `locked` maydoni majburiy, boshqa maydon yoki ortiqcha qiymat xato.
func DecodeCommand(line []byte) (Command, error) {
	var w wireCommand
	if err := decodeStrict(line, &w); err != nil {
		return Command{}, fmt.Errorf("buyruq noto'g'ri: %w", err)
	}
	if w.Locked == nil {
		return Command{}, errors.New("buyruq noto'g'ri: locked yo'q")
	}
	return Command{Locked: *w.Locked}, nil
}

// EncodeReport hisobotni JSON qatoriga aylantiradi; noma'lum holat xato.
func EncodeReport(r Report) ([]byte, error) {
	if !validHook(r.Hook) {
		return nil, fmt.Errorf("noma'lum hook holati %q", r.Hook)
	}
	line, err := json.Marshal(wireReport(r))
	if err != nil {
		return nil, err
	}
	return append(line, '\n'), nil
}

// DecodeReport bitta qatorni o'qiydi. `hook` faqat active | off | failed.
func DecodeReport(line []byte) (Report, error) {
	var w wireReport
	if err := decodeStrict(line, &w); err != nil {
		return Report{}, fmt.Errorf("hisobot noto'g'ri: %w", err)
	}
	if !validHook(w.Hook) {
		return Report{}, fmt.Errorf("hisobot noto'g'ri: hook %q", w.Hook)
	}
	return Report(w), nil
}

func validHook(h string) bool {
	return h == HookActive || h == HookOff || h == HookFailed
}

func decodeStrict(line []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("qatorda bittadan ortiq qiymat")
	}
	return nil
}

// readLine bitta qatorni o'qiydi. r hajmi maxLine bo'lgan bufio.Reader: undan uzun qator xato (bufio.ErrBufferFull).
func readLine(r *bufio.Reader) ([]byte, error) {
	line, err := r.ReadSlice('\n')
	if err != nil {
		return nil, err
	}
	return bytes.Clone(line), nil
}

// readLoop ulanishdan qatorlarni o'qib decode bilan out'ga beradi; birinchi xatoni errc'ga yozib chiqadi.
// done yopilsa (ulanish egasi chiqqan) bloklanib qolmaydi.
func readLoop[T any](conn io.Reader, decode func([]byte) (T, error), out chan<- T, errc chan<- error, done <-chan struct{}) {
	r := bufio.NewReaderSize(conn, maxLine)
	for {
		line, err := readLine(r)
		var v T
		if err == nil {
			v, err = decode(line)
		}
		if err != nil {
			select {
			case errc <- err:
			case <-done:
			}
			return
		}
		select {
		case out <- v:
		case <-done:
			return
		}
	}
}

func or(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Hook guard'ning klaviatura hook'i. Ikkala metod ham bitta goroutine'dan (Guard.Run) chaqiriladi.
type Hook interface {
	// Install hook'ni o'rnatadi; o'rnatilgan bo'lsa yangisini qo'yib eskisini oladi (Windows jimgina olib tashlagan
	// hook qaytadi). Tugma holati faqat yangi o'rnatishda (hook yo'q edi) tozalanadi.
	Install() error
	// Uninstall hook'ni oladi va tugma holatini tozalaydi; o'rnatilmagan bo'lsa hech narsa qilmaydi.
	Uninstall()
}

// Dialer xizmat pipe'iga ulanadi.
type Dialer func(ctx context.Context) (io.ReadWriteCloser, error)

// Guard guard jarayonining holat mashinasi: pipe'dan buyruq oladi, hook'ni boshqaradi, holatni qaytaradi.
//
// Hook faqat `locked:true` paytida turadi. Har `locked:true` (heartbeat ham) hook'ni yangilaydi: Windows
// LowLevelHooksTimeout'dan oshgan hook'ni xabar bermay olib tashlaydi va buni tekshirishning ishonchli yo'li yo'q
// (Companion'dagi 31770b3 saboqi: bloklash paytida yo'qolgan hook keyingi lock'gacha qaytmasdi). Pipe uzilsa, xato
// xabar kelsa yoki StaleAfter davomida jimlik bo'lsa hook olinadi va RetryDelay'dan keyin qayta ulaniladi: xizmat
// yo'q paytda o'quvchi bloklanib qolmasin.
type Guard struct {
	Dial Dialer
	Hook Hook
	// HookDone yopilsa hook o'rnatib bo'lmaydi (Windows'da hook oqimi tugagan): Run ErrHookGone bilan qaytadi, jarayon
	// nol bo'lmagan kod bilan chiqadi va Supervisor uni qayta ishga tushiradi. nil — kuzatilmaydi.
	HookDone <-chan struct{}
	// Nol qiymatlar standartni bildiradi (RetryDelay, StaleAfter).
	RetryDelay time.Duration
	StaleAfter time.Duration
}

// ErrHookGone hook oqimi tugagan: guard jarayoni hook'siz tirik qolmasligi kerak.
var ErrHookGone = errors.New("hook oqimi tugagan")

// Run ctx bekor qilinguncha ulanadi va xizmat qiladi. ctx bekor qilinsa ctx.Err(), HookDone yopilsa ErrHookGone
// qaytaradi. Qaytganda hook olingan.
func (g *Guard) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	if g.HookDone != nil {
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			select {
			case <-g.HookDone:
				cancel(ErrHookGone)
			case <-stop:
			}
		}()
	}
	err := g.loop(ctx)
	if cause := context.Cause(ctx); errors.Is(cause, ErrHookGone) {
		return cause
	}
	return err
}

func (g *Guard) loop(ctx context.Context) error {
	for {
		if conn, err := g.Dial(ctx); err == nil {
			g.serve(ctx, conn)
		}
		if err := sleep(ctx, or(g.RetryDelay, RetryDelay)); err != nil {
			return err
		}
	}
}

// serve bitta ulanishga xizmat qiladi; ulanish tugaganda hook olingan va ulanish yopilgan bo'ladi.
func (g *Guard) serve(ctx context.Context, conn io.ReadWriteCloser) {
	// ctx bekor qilinsa yopish kutilayotgan o'qish/yozishni ham to'xtatadi.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	defer conn.Close()

	installed := false
	defer func() {
		if installed {
			g.Hook.Uninstall()
		}
	}()

	done := make(chan struct{})
	defer close(done)
	cmds := make(chan Command)
	errc := make(chan error, 1)
	go readLoop(conn, DecodeCommand, cmds, errc, done)

	staleAfter := or(g.StaleAfter, StaleAfter)
	stale := time.NewTimer(staleAfter)
	defer stale.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-errc:
			return
		case <-stale.C:
			return
		case cmd := <-cmds:
			stale.Reset(staleAfter)
			state := HookOff
			if cmd.Locked {
				if err := g.Hook.Install(); err != nil {
					// Avvalgi hook (bo'lsa) turibdi, lekin uni yangilab bo'lmadi: keyingi heartbeat qayta urinadi.
					state = HookFailed
				} else {
					installed, state = true, HookActive
				}
			} else if installed {
				g.Hook.Uninstall()
				installed = false
			}
			line, _ := EncodeReport(Report{Hook: state}) // state doim ma'lum qiymat
			if _, err := conn.Write(line); err != nil {
				return
			}
		}
	}
}
