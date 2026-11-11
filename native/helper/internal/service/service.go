// Package service helper xizmatining orkestri: hub'dan bloklash holatini oladi va uni hamma komponentga (klaviatura
// guard'i, reyestr siyosati, process guard, Ctrl+Alt+Del) yetkazadi, Companion va guard jarayonlarini o'quvchi
// sessiyasida tirik ushlaydi, MeshAgent'ni kuzatadi va holatni hub'ga hisobot qiladi.
//
// Bu fayl toza mantiq: hamma komponent port (interfeys) orqali beriladi va soxta portlar bilan har OS'da test
// qilinadi. Windows'dagi ulash `run_windows.go`da.
//
// Konkurentlik: Start, Step va Stop bitta goroutine'dan ketma-ket chaqiriladi (xizmat tsikli). Faqat
// NotifySessionChange boshqa goroutine'dan (SCM handler) chaqirilishi mumkin.
package service

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/cad"
	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
	"github.com/humoyun-dev/net-school/native/helper/internal/supervise"
)

// Oraliqlar (reja: Task 10, Global Constraints).
const (
	// StepInterval Step shu oraliqda chaqiriladi (run_windows.go).
	StepInterval = time.Second
	// HubPollInterval hub lock-state so'rovi oralig'i; yiqilgan status hisobotini qayta yuborish ham shu.
	HubPollInterval = 5 * time.Second
	// SessionPollInterval SessionChange bildirishnomasi kelmasa ham faol sessiya shu oraliqda qayta so'raladi.
	SessionPollInterval = 5 * time.Second
	// DriftInterval bloklash paytida siyosat qayta qo'llanadi (o'quvchi yoki boshqa dastur qiymatni o'zgartirgan
	// bo'lsa).
	DriftInterval = 10 * time.Second
	// MeshInterval MeshAgent xizmati tekshiruvi.
	MeshInterval = 15 * time.Second
	// StatusInterval o'zgarish bo'lmasa ham status shu oraliqda yuboriladi.
	StatusInterval = 30 * time.Second
	// CleanupInterval bloklash yo'q paytida qoldiq siyosat jurnali va Ctrl+Alt+Del jurnali shu oraliqda qayta
	// tozalanadi; bloklash paytida esa yiqilgan Ctrl+Alt+Del va process guard shu oraliqda qayta yoqiladi
	// (cad.RetryInterval bilan bir xil: har urinish sekin PowerShell bo'lishi mumkin).
	CleanupInterval = cad.RetryInterval
	// StopTimeout to'xtatishda Ctrl+Alt+Del'ni qaytarish uchun yangi ctx muddati.
	StopTimeout = 30 * time.Second
)

// Session faol konsol sessiyasi va unga kirgan foydalanuvchi (session.Session'ning toza nusxasi).
type Session struct {
	ID      uint32
	UserSID string
}

// Hub hub.Client.
type Hub interface {
	LockState(ctx context.Context) (hub.LockState, error)
	ReportStatus(ctx context.Context, s hub.Status) error
}

// Lock lock.Lock.
type Lock interface {
	Apply(hub.LockState)
	Tick()
	Locked() bool
	Restore()
	StoreErr() error
}

// Policy policy.Policy.
type Policy interface {
	Apply(userSID string) error
	Restore() error
	Pending() bool
}

// Guard guard.Link: klaviatura guard'iga bloklash holatini yetkazadi.
type Guard interface {
	Set(locked bool)
	Hook() string
	LastError() error
}

// ProcGuard procguard.Scanner.
type ProcGuard interface {
	Start(session uint32) error
	Stop()
	State() string
	Stats() (killed, failed uint64, lastErr error)
}

// CAD cad.Guard.
type CAD interface {
	Start(ctx context.Context)
	Probe()
	Set(ctx context.Context, locked bool) string
	Pending() bool
	Retry(ctx context.Context)
	State() string
	Reason() string
}

// Child sessiyaga bog'langan, Supervisor kuzatadigan jarayon (Companion, guard). Realizatsiya: SessionChild.
type Child interface {
	// Move jarayonni s sessiyasida qayta ishga tushiradi; ok false bo'lsa (konsolda foydalanuvchi yo'q) to'xtatadi.
	Move(s Session, ok bool)
	// State supervise.State* qiymatlari.
	State() string
	LastError() error
}

// Mesh meshwatch: MeshAgent xizmatini tekshiradi va to'xtagan bo'lsa ishga tushiradi.
type Mesh interface {
	Check() (state string, err error)
}

// Sessions faol konsol sessiyasini topadi (session.ActiveConsole).
type Sessions interface {
	ActiveConsole() (Session, bool, error)
}

// Shell bloklashdan keyin sessiyada explorer.exe borligini ta'minlaydi (process guard bloklash paytida qayta
// ishga tushgan explorer'ni to'xtatadi).
type Shell interface {
	Ensure(s Session) error
}

// Clock monoton vaqt (lock.Clock'ning Uptime qismi).
type Clock interface {
	Uptime() time.Duration
}

// Logger xatolarni jurnalga (Windows Event Log) yozadi. Status hisobotida sabab maydoni yo'q, shuning uchun
// xato matnlari faqat shu yerda ko'rinadi.
type Logger func(format string, args ...any)

// Deps xizmat portlari. Log nil bo'lsa jurnal yozilmaydi.
type Deps struct {
	Hub       Hub
	Lock      Lock
	Policy    Policy
	Guard     Guard
	ProcGuard ProcGuard
	CAD       CAD
	Companion Child
	GuardProc Child
	Mesh      Mesh
	Sessions  Sessions
	Shell     Shell
	Clock     Clock
	Log       Logger
	Version   string
}

// Service bloklash orkestri.
type Service struct {
	d Deps

	notify atomic.Bool // SessionChange keldi, keyingi Step sessiyani qayta so'raydi

	locked      bool
	policyState string
	// pgStartErr oxirgi ProcGuard.Start xatosi (Stop'da tozalanadi). Qayta urinish faqat shunga qaraydi, State'ga
	// emas: ishlayotgan Scanner snapshot yiqilganda ham `failed` deydi, uni qayta Start qilish esa bloklash o'rtasida
	// yangi baseline olardi (bloklash paytida ochilgan dasturlar dars oxirigacha ruxsat etilgan bo'lib qolardi).
	pgStartErr error

	sessionKnown bool
	hasSession   bool
	session      Session

	mesh string

	// keyingi bajarilish paytlari (uptime); nol — birinchi Step'da.
	nextPoll, nextSession, nextDrift, nextCleanup, nextMesh time.Duration

	sent          bool
	lastSent      hub.Status
	lastSentAt    time.Duration
	reportRetryAt time.Duration

	notes map[string]string // jurnalga yozilgan oxirgi xato (kalit bo'yicha): faqat o'zgarganda yoziladi
}

func New(d Deps) *Service {
	if d.Log == nil {
		d.Log = func(string, ...any) {}
	}
	return &Service{d: d, policyState: hub.ComponentOff, mesh: hub.MeshAgentRunning, notes: map[string]string{}}
}

// due now next'ga yetgan bo'lsa true qaytaradi va next'ni every'ga suradi.
func due(next *time.Duration, now, every time.Duration) bool {
	if now < *next {
		return false
	}
	*next = now + every
	return true
}

// NotifySessionChange SCM SessionChange hodisasida (logon, logoff, konsol ulanishi) chaqiriladi: keyingi Step
// sessiyani darhol qayta so'raydi. Istalgan goroutine'dan xavfsiz.
func (s *Service) NotifySessionChange() { s.notify.Store(true) }

// Start xizmat ishga tushganda, birinchi Step'dan oldin bir marta: saqlangan lock (shu boot'da) tiklanadi,
// Ctrl+Alt+Del qoldig'i tozalanadi va bloklash bo'lmasa qoldiq siyosat qaytariladi, Keyboard Filter mavjudligi
// aniqlanadi (Pro/Home darhol `unavailable`).
//
// Tiklangan faol lock bo'lsa CAD.Start (qoldiq filtrni ochish) chaqirilmaydi: aks holda Ctrl+Alt+Del birinchi
// Step qayta bloklaguncha dars paytida ochiq qolardi. Qoldiq jurnalni birinchi Step'dagi Set(true) o'z zimmasiga
// oladi (u avval ochmasdan bloklaydi).
func (s *Service) Start(ctx context.Context) {
	s.d.Lock.Restore()
	s.note("lock.json", s.d.Lock.StoreErr())
	if s.d.Lock.Locked() {
		return
	}
	s.d.CAD.Start(ctx)
	if s.d.Policy.Pending() {
		s.restorePolicy()
	}
	s.d.CAD.Probe()
	s.noteCAD()
}

// Step har StepInterval'da chaqiriladi.
func (s *Service) Step(ctx context.Context) {
	now := s.d.Clock.Uptime()

	if due(&s.nextPoll, now, HubPollInterval) {
		state, err := s.d.Hub.LockState(ctx)
		s.note("hub lock-state", err)
		if err == nil {
			s.d.Lock.Apply(state)
		}
	}
	// Lease hub'siz ham tugashi uchun Tick har Step'da (lock.Locked muddatni o'zi tekshirmaydi).
	s.d.Lock.Tick()
	s.note("lock.json", s.d.Lock.StoreErr())

	if s.notify.Swap(false) || due(&s.nextSession, now, SessionPollInterval) {
		s.checkSession()
	}

	locked := s.d.Lock.Locked()
	switch {
	case locked && !s.locked:
		s.engage(ctx, now)
	case !locked && s.locked:
		s.release(ctx)
	case locked && s.hasSession && due(&s.nextDrift, now, DriftInterval):
		s.applyPolicy()
	}

	if due(&s.nextCleanup, now, CleanupInterval) {
		if locked {
			s.retryFailed(ctx)
		} else {
			if s.d.Policy.Pending() {
				s.restorePolicy()
			}
			if s.d.CAD.Pending() {
				s.d.CAD.Retry(ctx)
				s.noteCAD()
			}
		}
	}

	if due(&s.nextMesh, now, MeshInterval) {
		state, err := s.d.Mesh.Check()
		s.note("MeshAgent", err)
		if state != "" {
			s.mesh = state
		}
	}

	s.noteComponents()
	s.report(ctx, now)
}

// Stop xizmat to'xtaganda (Step tsikli tugagach) chaqiriladi: hamma narsa qaytariladi. Ctrl+Alt+Del yangi ctx
// bilan qaytariladi (to'xtatish ctx'i allaqachon bekor qilingan).
func (s *Service) Stop() {
	ctx, cancel := context.WithTimeout(context.Background(), StopTimeout)
	defer cancel()
	s.stopProcGuard()
	s.d.Guard.Set(false)
	s.d.Companion.Move(Session{}, false)
	s.d.GuardProc.Move(Session{}, false)
	wasLocked := s.locked
	s.locked = false
	s.restorePolicy()
	s.d.CAD.Set(ctx, false)
	s.noteCAD()
	if wasLocked && s.hasSession {
		s.note("explorer", s.d.Shell.Ensure(s.session))
	}
}

// checkSession faol sessiyani so'raydi va o'zgargan bo'lsa (yoki birinchi marta) hamma narsani ko'chiradi.
func (s *Service) checkSession() {
	sess, ok, err := s.d.Sessions.ActiveConsole()
	s.note("faol sessiya", err)
	if err != nil {
		return
	}
	if !ok {
		sess = Session{}
	}
	if s.sessionKnown && ok == s.hasSession && sess == s.session {
		return
	}
	s.sessionKnown, s.hasSession, s.session = true, ok, sess
	s.d.Companion.Move(sess, ok)
	s.d.GuardProc.Move(sess, ok)
	if s.locked {
		// Baseline yangi sessiya uchun olinadi; siyosat yangi foydalanuvchi hive'iga (eski foydalanuvchi qoldig'ini
		// Policy.Apply o'zi tiklaydi).
		s.stopProcGuard()
		if ok {
			s.applyPolicy()
			s.startProcGuard(sess.ID)
		} else {
			s.policyState = hub.ComponentOff
		}
		return
	}
	if s.d.Policy.Pending() {
		s.restorePolicy()
	}
}

// engage bloklashni yoqadi. Tartib: tezlari avval (klaviatura guard'i, siyosat, process guard), sekin PowerShell
// (Ctrl+Alt+Del) oxirida.
func (s *Service) engage(ctx context.Context, now time.Duration) {
	s.locked = true
	s.d.Guard.Set(true)
	if s.hasSession {
		s.applyPolicy()
		s.startProcGuard(s.session.ID)
	}
	s.nextDrift = now + DriftInterval
	s.nextCleanup = now + CleanupInterval
	s.d.CAD.Set(ctx, true)
	s.noteCAD()
}

// release bloklashni o'chiradi. Bloklash paytida explorer o'ldirilgan bo'lishi mumkin: sessiyada qayta tiklanadi.
func (s *Service) release(ctx context.Context) {
	s.locked = false
	s.d.Guard.Set(false)
	s.stopProcGuard()
	s.restorePolicy()
	s.d.CAD.Set(ctx, false)
	s.noteCAD()
	if s.hasSession {
		s.note("explorer", s.d.Shell.Ensure(s.session))
	}
}

// applyPolicy siyosatni joriy foydalanuvchiga qo'llaydi. Apply xatosi lock'ni bekor qilmaydi: Apply iloji boricha
// ko'p qiymat yozadi va xato eski foydalanuvchi qoldig'ini tiklay olmaganidan ham bo'lishi mumkin (ajratib
// bo'lmaydi), shuning uchun holat `failed`, qolgan komponentlar yoqilgan qoladi.
func (s *Service) applyPolicy() {
	err := s.d.Policy.Apply(s.session.UserSID)
	s.note("siyosat", err)
	if err != nil {
		s.policyState = hub.ComponentFailed
		return
	}
	s.policyState = hub.ComponentActive
}

// restorePolicy jurnal bo'yicha siyosatni qaytaradi. Bloklash yo'q paytida holat shu yerda aniqlanadi: jurnalda
// tiklanmagan yozuv qolsa `failed` (o'quvchi hali cheklangan bo'lishi mumkin), aks holda `off`.
// startProcGuard process guard'ni sessiya uchun yoqadi (baseline) va Start xatosini qayta urinish uchun eslaydi.
func (s *Service) startProcGuard(id uint32) {
	s.pgStartErr = s.d.ProcGuard.Start(id)
	s.note("process guard", s.pgStartErr)
}

func (s *Service) stopProcGuard() {
	s.d.ProcGuard.Stop()
	s.pgStartErr = nil
}

func (s *Service) restorePolicy() {
	s.note("siyosatni tiklash", s.d.Policy.Restore())
	if s.locked {
		return
	}
	s.policyState = hub.ComponentOff
	if s.d.Policy.Pending() {
		s.policyState = hub.ComponentFailed
	}
}

// retryFailed bloklash paytida yiqilgan komponentlarni qayta yoqadi ("Set faqat o'zgarishda" har soniyani
// taqiqlaydi, yiqilganini qayta urinishni emas): Ctrl+Alt+Del `failed` bo'lsa Set(true), sessiya bor va process
// guard'ning oxirgi Start'i yiqilgan bo'lsa Start (ishlayotgan Scanner hech qachon qayta baseline olmaydi).
func (s *Service) retryFailed(ctx context.Context) {
	if s.d.CAD.State() == hub.CADFailed {
		s.d.CAD.Set(ctx, true)
		s.noteCAD()
	}
	if s.hasSession && s.pgStartErr != nil {
		s.startProcGuard(s.session.ID)
	}
}

func (s *Service) noteCAD() {
	var err error
	if st := s.d.CAD.State(); st == hub.CADFailed || st == hub.CADUnavailable {
		err = errors.New(st + ": " + s.d.CAD.Reason())
	}
	s.note("Ctrl+Alt+Del", err)
}

// noteComponents fon komponentlarining oxirgi xatolarini (o'zgarganda) jurnalga yozadi.
func (s *Service) noteComponents() {
	s.note("guard pipe", s.d.Guard.LastError())
	s.note("Companion", s.d.Companion.LastError())
	s.note("guard jarayoni", s.d.GuardProc.LastError())
	_, _, err := s.d.ProcGuard.Stats()
	s.note("process guard", err)
}

// note xato matni o'zgarganda jurnalga yozadi (har Step'da takrorlanmaydi); xato yo'qolsa bu ham bir marta yoziladi.
func (s *Service) note(key string, err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	if s.notes[key] == msg {
		return
	}
	s.notes[key] = msg
	if msg == "" {
		s.d.Log("%s: xato bartaraf bo'ldi", key)
		return
	}
	s.d.Log("%s: %s", key, msg)
}

func (s *Service) status() hub.Status {
	companion := hub.CompanionRestarting
	switch {
	case !s.hasSession:
		companion = hub.CompanionNoSession
	case s.d.Companion.State() == supervise.StateRunning:
		companion = hub.CompanionRunning
	}
	return hub.Status{
		Version:      s.d.Version,
		Hook:         s.d.Guard.Hook(),
		Policy:       s.policyState,
		ProcessGuard: s.d.ProcGuard.State(),
		CAD:          s.d.CAD.State(),
		Companion:    companion,
		MeshAgent:    s.mesh,
	}
}

// report status o'zgarganda yoki StatusInterval o'tganda yuboradi. Yiqilsa HubPollInterval'dan keyin qayta.
func (s *Service) report(ctx context.Context, now time.Duration) {
	if now < s.reportRetryAt {
		return
	}
	st := s.status()
	if s.sent && st == s.lastSent && now < s.lastSentAt+StatusInterval {
		return
	}
	err := s.d.Hub.ReportStatus(ctx, st)
	// Konfiguratsiya yo'qligi lock-state so'rovida allaqachon yozilgan: bir xil sabab ikki marta yozilmasin.
	if !errors.As(err, new(*HubUnavailableError)) {
		s.note("hub status", err)
	}
	if err != nil {
		s.sent = false
		s.reportRetryAt = now + HubPollInterval
		return
	}
	s.sent, s.lastSent, s.lastSentAt = true, st, now
}
