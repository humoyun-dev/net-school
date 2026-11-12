// Package supervise bola jarayonni (Companion, guard) tirik ushlaydi: jarayon tugasa yoki o'ldirilsa qayta ishga
// tushiradi, crash-loop'da esa CPU'ni yemaslik uchun kutish vaqtini oshiradi.
// Toza mantiq: hech qanday OS kodi yo'q, jarayon ishga tushirish va soat tashqaridan beriladi.
package supervise

import (
	"context"
	"errors"
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
	// qaytishi kerak: ishga tushib olgan jarayondan keyin har doim shu kutiladi.
	MinBackoff = time.Second
	// MaxBackoff kutishning yuqori chegarasi (crash-loop'da har 30 s da bitta urinish).
	MaxBackoff = 30 * time.Second
	// StartupCrashWindow jarayon shundan kam yashasa bu "ishga tushishda yiqilish" (buzilgan o'rnatish, sessiya yo'q)
	// va kutish ikki baravar oshadi. Shuncha yoki ko'proq yashagan jarayon ishga tushib olgan: uni o'quvchi o'ldirgan
	// bo'lishi mumkin, shuning uchun kutish MinBackoff'ga qaytadi. Chegara katta (masalan, 60 s) bo'lsa, Companion'ni
	// har 10 s da o'ldirib kutishni 30 s gacha cho'zish va shu oraliqda bloklashdan qochish mumkin bo'lardi; har
	// qayta ishga tushish ≤ 3 s talabi buni taqiqlaydi. 5 s da tez yiqiladigan jarayon CPU'ni yemaydi.
	StartupCrashWindow = 5 * time.Second
)

// errNilProc Launcher xatosiz, lekin nil Proc qaytardi.
var errNilProc = errors.New("launcher nil Proc qaytardi")

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

// Supervisor bitta bola jarayonni kuzatadi. Run bitta goroutine'da ishlaydi; State va LastError istalgan
// goroutine'dan xavfsiz.
//
// Kutish: jarayon StartupCrashWindow (5 s) dan kam yashagan bo'lsa 1 s, 2 s, 4 s … 30 s gacha ikki baravar oshadi;
// 5 s yoki ko'proq yashagan bo'lsa yana 1 s. Ishga tushmay qolish (Start xato yoki nil Proc qaytarsa, masalan
// sessiyada foydalanuvchi yo'q) ham tez yiqilish hisoblanadi.
type Supervisor struct {
	name     string
	launcher Launcher
	clock    Clock

	mu      sync.Mutex
	state   string
	lastErr error
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

// LastError oxirgi nil bo'lmagan xato: Start xatosi, Wait xatosi (jarayon nol bo'lmagan kod bilan tugagan yoki
// o'ldirilgan) yoki bekor qilishdagi Kill xatosi. Tozalanmaydi: jarayon hozir ishlayotgan bo'lsa ham u oldingi
// tugash sababini ko'rsatadi (diagnostika uchun); hozirgi holatni State beradi. Hali xato bo'lmagan bo'lsa nil.
func (s *Supervisor) LastError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

func (s *Supervisor) setState(v string) {
	s.mu.Lock()
	s.state = v
	s.mu.Unlock()
}

func (s *Supervisor) recordErr(err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	s.lastErr = err
	s.mu.Unlock()
}

// Run ctx bekor qilinguncha jarayonni qayta-qayta ishga tushiradi. Bekor qilinganda ishlab turgan jarayon
// o'ldiriladi va Run (Kill muvaffaqiyatli bo'lsa jarayon tugashini kutib) qaytadi.
func (s *Supervisor) Run(ctx context.Context) {
	defer s.setState(StateStopped)
	delay := MinBackoff
	for ctx.Err() == nil {
		started := s.clock.Now()
		p, err := s.launcher.Start()
		if err == nil && p == nil {
			err = errNilProc
		}
		s.recordErr(err)
		if err == nil {
			s.setState(StateRunning)
			if !s.wait(ctx, p) {
				return
			}
		}
		if s.clock.Now().Sub(started) >= StartupCrashWindow {
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
// Wait goroutine'i jarayon tugaganda o'zi chiqadi (kanal buferli, goroutine bloklanib qolmaydi).
func (s *Supervisor) wait(ctx context.Context, p Proc) bool {
	exited := make(chan error, 1)
	go func() { exited <- p.Wait() }()
	select {
	case err := <-exited:
		s.recordErr(err)
		return true
	case <-ctx.Done():
		if err := p.Kill(); err != nil {
			s.recordErr(err)
			return false
		}
		s.recordErr(<-exited)
		return false
	}
}
