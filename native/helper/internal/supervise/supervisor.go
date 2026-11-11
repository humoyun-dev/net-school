// Package supervise bola jarayonni (Companion, guard) tirik ushlaydi: jarayon tugasa yoki o'ldirilsa qayta ishga
// tushiradi, crash-loop'da esa CPU'ni yemaslik uchun kutish vaqtini oshiradi.
// Toza mantiq: hech qanday OS kodi yo'q, jarayon ishga tushirish va soat tashqaridan beriladi.
package supervise

import (
	"context"
	"sync"
	"time"
)

// State qiymatlari.
const (
	StateRunning    = "running"    // bola jarayon ishlayapti
	StateRestarting = "restarting" // jarayon tugadi yoki ishga tushmadi, qayta ishga tushirishni kutyapti
	StateStopped    = "stopped"    // Run hali boshlanmagan yoki ctx bekor qilingan
)

const (
	// MinBackoff birinchi qayta ishga tushirishdan oldingi kutish. O'quvchi Companion'ni o'ldirsa u ≤ 3 s ichida
	// qaytishi kerak: barqaror ishlagan jarayondan keyin har doim shu kutiladi.
	MinBackoff = time.Second
	// MaxBackoff kutishning yuqori chegarasi (crash-loop'da har 30 s da bitta urinish).
	MaxBackoff = 30 * time.Second
	// StableRun jarayon kamida shuncha yashasa u "barqaror" hisoblanadi va kutish MinBackoff'ga qaytadi.
	StableRun = 60 * time.Second
)

// Launcher bola jarayonni ishga tushiradi. Har Start yangi jarayon (sessiya o'zgargan bo'lsa yangi sessiyada).
type Launcher interface {
	Start() (Proc, error)
}

// Proc ishga tushgan jarayon. Wait jarayon tugaguncha bloklanadi (bir marta chaqiriladi); Kill uni to'xtatadi va
// jarayon allaqachon tugagan bo'lsa ham xavfsiz.
type Proc interface {
	Wait() error
	Kill() error
}

// Clock vaqt manbai (lock.Clock'dan alohida: bu yerda uptime emas, kutish kerak). Sleep ctx bekor qilinsa darhol
// ctx.Err() bilan qaytadi.
type Clock interface {
	Now() time.Time
	Sleep(ctx context.Context, d time.Duration) error
}

// SystemClock haqiqiy soat.
type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now() }

func (SystemClock) Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Supervisor bitta bola jarayonni kuzatadi. Run bitta goroutine'da ishlaydi; State istalgan goroutine'dan xavfsiz.
//
// Kutish: 1 s, 2 s, 4 s … 30 s gacha ikki baravar oshadi; jarayon ≥ 60 s yashagan bo'lsa yana 1 s dan boshlanadi.
// Ishga tushmay qolish (masalan, sessiyada foydalanuvchi yo'q; Start xato yoki nil Proc qaytarsa) ham tez yiqilish
// hisoblanadi.
type Supervisor struct {
	name     string
	launcher Launcher
	clock    Clock

	mu    sync.Mutex
	state string
}

func NewSupervisor(name string, l Launcher, clock Clock) *Supervisor {
	return &Supervisor{name: name, launcher: l, clock: clock, state: StateStopped}
}

// Name kuzatilayotgan jarayon nomi (log va holat hisobotlari uchun).
func (s *Supervisor) Name() string { return s.name }

// State `running` | `restarting` | `stopped`.
func (s *Supervisor) State() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *Supervisor) setState(v string) {
	s.mu.Lock()
	s.state = v
	s.mu.Unlock()
}

// Run ctx bekor qilinguncha jarayonni qayta-qayta ishga tushiradi. Bekor qilinganda ishlab turgan jarayon
// o'ldiriladi va Run (Kill muvaffaqiyatli bo'lsa jarayon tugashini kutib) qaytadi.
func (s *Supervisor) Run(ctx context.Context) {
	defer s.setState(StateStopped)
	delay := MinBackoff
	for ctx.Err() == nil {
		started := s.clock.Now()
		if p, err := s.launcher.Start(); err == nil && p != nil {
			s.setState(StateRunning)
			if !s.wait(ctx, p) {
				return
			}
		}
		if s.clock.Now().Sub(started) >= StableRun {
			delay = MinBackoff
		}
		s.setState(StateRestarting)
		if s.clock.Sleep(ctx, delay) != nil {
			return
		}
		delay = min(delay*2, MaxBackoff)
	}
}

// wait jarayon tugashini yoki ctx bekor qilinishini kutadi. Jarayon o'zi tugasa true; ctx bekor qilinsa jarayonni
// o'ldiradi va false. Kill xato bersa (jarayon to'xtamagan bo'lishi mumkin) Wait kutilmaydi: Run osilib qolmasin,
// Wait goroutine'i jarayon tugaganda o'zi chiqadi.
func (s *Supervisor) wait(ctx context.Context, p Proc) bool {
	exited := make(chan struct{})
	go func() {
		_ = p.Wait()
		close(exited)
	}()
	select {
	case <-exited:
		return true
	case <-ctx.Done():
		if p.Kill() == nil {
			<-exited
		}
		return false
	}
}
