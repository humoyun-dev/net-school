//go:build windows

package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"golang.org/x/sys/windows"
	winsvc "golang.org/x/sys/windows/svc"

	"github.com/humoyun-dev/net-school/native/helper/internal/cad"
	"github.com/humoyun-dev/net-school/native/helper/internal/fsacl"
	"github.com/humoyun-dev/net-school/native/helper/internal/guard"
	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
	"github.com/humoyun-dev/net-school/native/helper/internal/layout"
	"github.com/humoyun-dev/net-school/native/helper/internal/lock"
	"github.com/humoyun-dev/net-school/native/helper/internal/meshwatch"
	"github.com/humoyun-dev/net-school/native/helper/internal/policy"
	"github.com/humoyun-dev/net-school/native/helper/internal/procguard"
	"github.com/humoyun-dev/net-school/native/helper/internal/session"
	"github.com/humoyun-dev/net-school/native/helper/internal/supervise"
	"github.com/humoyun-dev/net-school/native/helper/internal/version"
)

// Name Windows xizmati nomi (Global Constraints).
const Name = "NetSchoolHelper"

// stopWaitHint SCM'ga to'xtash qancha davom etishi mumkinligi: Step tsikli bekor qilinadi, keyin Ctrl+Alt+Del
// PowerShell bilan qaytariladi (StopTimeout).
const stopWaitHint = StopTimeout + 15*time.Second

// paths helper ishlatadigan fayllar. Hammasi Known Folders'dan: muhit o'zgaruvchilariga ishonilmaydi.
//
// Helper hamma faylini faqat o'z katalogidan, `%ProgramData%\NetSchool\helper\`dan oladi (ACL: faqat SYSTEM va
// Administrators, o'qish ham; `install` o'rnatadi, xizmat har ishga tushishda fsacl.HardenHelperData bilan qayta
// o'rnatadi):
//   - `device.json` — hub konfiguratsiyasi (hubOrigin, deviceId; Companion enroll formati, install nusxalaydi);
//   - `hub-ca.pem` — hub CA'si; yo'q bo'lsa tizim root'lari (install nusxalaydi, agar enroll'da bo'lgan bo'lsa);
//   - `helper.key`, `lock.json`, `policy-journal.json`, `cad-journal.json`.
//
// Companion katalogi (`%ProgramData%\NetSchool\companion\`) umuman o'qilmaydi: unga oddiy foydalanuvchi fayl qo'sha
// oladi (ProgramData standart ACL'i), masalan soxta `hub-ca.pem` — shunda helper hub'ga ulanolmay, lock hech qachon
// yoqilmasdi. Fayllar yo'q bo'lsa xizmat ochiq holatda ishlaydi, hisobot yubormaydi va buni bir marta jurnalga yozadi.
type paths struct {
	dataRoot, helperData                       string
	deviceJSON, hubCA                          string
	helperKey, lock, policyJournal, cadJournal string
	helperExe, companionExe, explorerExe       string
}

func resolvePaths() (paths, error) {
	data, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return paths{}, fmt.Errorf("%%ProgramData%% aniqlanmadi: %w", err)
	}
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return paths{}, fmt.Errorf("%%ProgramFiles%% aniqlanmadi: %w", err)
	}
	root, err := windows.KnownFolderPath(windows.FOLDERID_Windows, 0)
	if err != nil {
		return paths{}, fmt.Errorf("%%SystemRoot%% aniqlanmadi: %w", err)
	}
	l := layout.New(pf, data, root)
	return paths{
		dataRoot:      l.DataRoot,
		helperData:    l.HelperData,
		deviceJSON:    l.DeviceJSON,
		hubCA:         l.HubCA,
		helperKey:     l.HelperKey,
		lock:          l.Lock,
		policyJournal: l.PolicyJournal,
		cadJournal:    l.CADJournal,
		helperExe:     l.HelperExe,
		companionExe:  l.CompanionExe,
		explorerExe:   l.Explorer,
	}, nil
}

// loadHub device.json, hub-ca.pem va helper.key'dan imzolangan hub mijozini yasaydi.
func loadHub(p paths) (Hub, error) {
	raw, err := os.ReadFile(p.deviceJSON)
	if err != nil {
		return nil, fmt.Errorf("helper device.json o'qilmadi (helper o'rnatilmagan yoki qurilma ro'yxatdan o'tmagan?): %w", err)
	}
	cfg, err := ParseDeviceConfig(raw)
	if err != nil {
		return nil, err
	}
	ca, err := os.ReadFile(p.hubCA)
	if errors.Is(err, os.ErrNotExist) {
		ca = nil
	} else if err != nil {
		return nil, fmt.Errorf("hub-ca.pem o'qilmadi: %w", err)
	}
	key, err := hub.LoadKey(p.helperKey)
	if err != nil {
		return nil, err
	}
	return hub.NewClient(cfg.HubOrigin, ca, hub.NewSigner(cfg.DeviceID, key, "helper", time.Now))
}

// Run helper'ni Windows xizmati sifatida ishga tushiradi (SCM'dan chaqirilganda). Xizmat to'xtaguncha qaytmaydi.
func Run() error { return winsvc.Run(Name, &handler{}) }

type handler struct{}

func (*handler) Execute(_ []string, requests <-chan winsvc.ChangeRequest, changes chan<- winsvc.Status) (bool, uint32) {
	changes <- winsvc.Status{State: winsvc.StartPending}
	log := openEventLogger()
	defer log.Close()

	p, err := resolvePaths()
	if err != nil {
		log.Warn("ishga tushmadi: %v", err)
		return true, 1
	}
	// O'z-o'zini tiklash: ma'lumot katalogining egasi va himoyalangan DACL'i har ishga tushishda, hech narsa
	// o'qilishidan oldin qayta o'rnatiladi. Yiqilsa jurnalga yoziladi va davom etiladi (fayl yo'q bo'lsa xizmat
	// baribir ochiq holatda ishlaydi).
	if trusted, err := fsacl.HardenHelperData(p.dataRoot, p.helperData); err != nil {
		log.Warn("helper katalogi himoyalanmadi: %v", err)
	} else if !trusted {
		log.Warn("helper katalogining egasi yoki DACL'i o'zgartirilgan edi, qayta o'rnatildi: %s", p.helperData)
	}
	clock := newSystemClock()

	// Job: Companion va guard xizmat jarayoni bilan birga o'ladi (oldingi nusxaning yetim jarayonlari qolmaydi).
	// Job yaratilmasa (bo'lmasligi kerak) jarayonlar Job'siz ishga tushadi va bu jurnalga yoziladi.
	startUser, startSystem := session.StartAsUser, session.StartAsSystemInSession
	job, err := session.NewJob()
	if err != nil {
		log.Warn("Job obyekti: %v", err)
	} else {
		defer job.Close()
		startUser, startSystem = job.StartAsUser, job.StartAsSystemInSession
	}

	var pg ProcGuard
	if scanner, err := procguard.NewScanner(); err != nil {
		log.Warn("process guard: %v", err)
		pg = failedProcGuard{err: err}
	} else {
		pg = scanner
	}

	listener := &lazyListener{}
	link := guard.NewLink(listener)
	s := New(Deps{
		Hub:       NewLazyHub(func() (Hub, error) { return loadHub(p) }, clock),
		Lock:      lock.New(clock, lock.NewFileStore(p.lock)),
		Policy:    policy.NewPolicy(policy.NewRegistry(), p.policyJournal),
		Guard:     link,
		ProcGuard: pg,
		CAD:       cad.NewGuard(cad.NewKeyboardFilter(), p.cadJournal),
		Companion: NewSessionChild("companion", func(s Session) supervise.Launcher {
			return launcher(func() (supervise.Proc, error) { return startUser(toSession(s), p.companionExe, nil) })
		}, supervise.SystemClock{}),
		GuardProc: NewSessionChild("guard", func(s Session) supervise.Launcher {
			return launcher(func() (supervise.Proc, error) {
				return startSystem(toSession(s), p.helperExe, []string{"guard"})
			})
		}, supervise.SystemClock{}),
		Mesh:     meshFunc(meshwatch.Check),
		Sessions: consoleSessions{},
		Shell:    explorerShell{exe: p.explorerExe},
		Clock:    clock,
		Log:      log.Warn,
		Version:  version.Version,
	})

	ctx, cancel := context.WithCancel(context.Background())
	linkDone := make(chan struct{})
	go func() {
		defer close(linkDone)
		link.Run(ctx)
	}()

	// Start sekin bo'lishi mumkin (PowerShell): SCM ishga tushish muddatiga tushmaslik uchun Running'dan keyin,
	// Step bilan bir goroutine'da (Start/Step/Stop ketma-ketligi shu goroutine'da).
	stepDone := make(chan struct{})
	go func() {
		defer close(stepDone)
		s.Start(ctx)
		t := time.NewTicker(StepInterval)
		defer t.Stop()
		for ctx.Err() == nil {
			s.Step(ctx)
			select {
			case <-ctx.Done():
			case <-t.C:
			}
		}
	}()

	const accepts = winsvc.AcceptStop | winsvc.AcceptShutdown | winsvc.AcceptSessionChange
	changes <- winsvc.Status{State: winsvc.Running, Accepts: accepts}
	log.Info("NetSchool Helper %s ishga tushdi", version.Version)

loop:
	for req := range requests {
		switch req.Cmd {
		case winsvc.Interrogate:
			changes <- req.CurrentStatus
		case winsvc.Stop, winsvc.Shutdown:
			break loop
		case winsvc.SessionChange:
			// Logon, logoff, konsol ulanishi/uzilishi: Step faol sessiyani qayta so'raydi va o'zgargan bo'lsa
			// Supervisor'larni, siyosatni va process guard'ni ko'chiradi.
			s.NotifySessionChange()
		}
	}

	changes <- winsvc.Status{State: winsvc.StopPending, WaitHint: uint32(stopWaitHint / time.Millisecond)}
	cancel()
	<-stepDone
	<-linkDone
	listener.Close()
	s.Stop()
	log.Info("NetSchool Helper to'xtadi")
	return false, 0
}

func toSession(s Session) session.Session { return session.Session{ID: s.ID, UserSID: s.UserSID} }

type launcher func() (supervise.Proc, error)

func (l launcher) Start() (supervise.Proc, error) { return l() }

type meshFunc func() (string, error)

func (m meshFunc) Check() (string, error) { return m() }

type consoleSessions struct{}

func (consoleSessions) ActiveConsole() (Session, bool, error) {
	s, ok, err := session.ActiveConsole()
	return Session{ID: s.ID, UserSID: s.UserSID}, ok, err
}

// lazyListener guard pipe'ini birinchi Accept'da yaratadi; yaratilmasa xato qaytaradi va Link RetryDelay'dan
// keyin qayta uradi (xato Link.LastError orqali jurnalga tushadi). Accept va Close bitta Link.Run goroutine'idan
// va undan keyin chaqiriladi.
type lazyListener struct{ l *guard.PipeListener }

func (z *lazyListener) Accept(ctx context.Context) (io.ReadWriteCloser, error) {
	if z.l == nil {
		l, err := guard.Listen()
		if err != nil {
			return nil, err
		}
		z.l = l
	}
	return z.l.Accept(ctx)
}

func (z *lazyListener) Close() {
	if z.l != nil {
		_ = z.l.Close()
	}
}

// failedProcGuard procguard.NewScanner yiqilganda: bloklash paytida `failed`.
type failedProcGuard struct{ err error }

func (f failedProcGuard) Start(uint32) error             { return f.err }
func (failedProcGuard) Stop()                            {}
func (failedProcGuard) State() string                    { return hub.ComponentFailed }
func (f failedProcGuard) Stats() (uint64, uint64, error) { return 0, 0, f.err }
