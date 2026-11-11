//go:build windows

// Package session faol konsol sessiyasini topadi va unda jarayon ishga tushiradi: sessiya foydalanuvchisi nomidan
// (Companion) yoki SYSTEM sifatida shu sessiya ichida (guard). Chaqiruvchi LocalSystem xizmati bo'lishi kerak
// (WTSQueryUserToken va TokenSessionId o'zgartirish SeTcbPrivilege talab qiladi). Shell ishlatilmaydi: exe mutlaq
// yo'l bilan lpApplicationName'ga beriladi, buyruq qatori argumentlardan windows.ComposeCommandLine bilan yasaladi.
package session

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/humoyun-dev/net-school/native/helper/internal/supervise"
)

// noSession WTSGetActiveConsoleSessionId konsolga hech qanday sessiya ulanmaganda (masalan, sessiya almashayotganda)
// qaytaradigan qiymat.
const noSession = 0xFFFFFFFF

// desktop interaktiv oyna stantsiyasi va foydalanuvchi ish stoli: busiz jarayon ko'rinmas ish stolida ochiladi.
const desktop = `winsta0\default`

// killExitCode Kill jarayonni shu chiqish kodi bilan to'xtatadi.
const killExitCode = 1

var (
	// ErrSessionChanged sessiyadagi foydalanuvchi Session.UserSID emas (ActiveConsole'dan keyin kimdir chiqib, boshqasi
	// kirgan). Chaqiruvchi ActiveConsole'ni qayta so'raydi.
	ErrSessionChanged = errors.New("sessiya foydalanuvchisi o'zgargan")
	// ErrWaited Wait ikkinchi marta chaqirildi (jarayon dastagi birinchi Wait'da yopilgan).
	ErrWaited = errors.New("jarayon allaqachon kutilgan")
)

// Session faol konsol sessiyasi va unga kirgan foydalanuvchi.
type Session struct {
	ID      uint32
	UserSID string
}

var (
	modwtsapi32                     = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSQuerySessionInformationW = modwtsapi32.NewProc("WTSQuerySessionInformationW")
)

// WTS_INFO_CLASS qiymatlari (wtsapi32.h).
const (
	wtsUserName   = 5
	wtsDomainName = 7
)

// ActiveConsole faol konsol sessiyasini qaytaradi. Konsolga sessiya ulanmagan yoki unda foydalanuvchi yo'q
// (kirish ekrani) bo'lsa (Session{}, false, nil).
//
// Foydalanuvchi SID'i sessiya tokenidan olinadi (WTSQueryUserToken, SYSTEM'da). Chaqiruvchi SYSTEM bo'lmasa
// (ERROR_PRIVILEGE_NOT_HELD: dasturchi mashinasi, CI) sessiyadagi foydalanuvchi nomi va domeni bo'yicha
// LookupAccountName ishlatiladi; xizmatning o'zi doim birinchi yo'ldan boradi.
func ActiveConsole() (Session, bool, error) {
	id := windows.WTSGetActiveConsoleSessionId()
	if id == noSession {
		return Session{}, false, nil
	}
	var tok windows.Token
	err := windows.WTSQueryUserToken(id, &tok)
	switch {
	case err == nil:
		defer tok.Close()
		sid, err := tokenSID(tok)
		if err != nil {
			return Session{}, false, err
		}
		return Session{ID: id, UserSID: sid}, true, nil
	case errors.Is(err, windows.ERROR_NO_TOKEN), errors.Is(err, windows.ERROR_FILE_NOT_FOUND):
		// Foydalanuvchi kirmagan yoki sessiya shu orada yo'qolgan.
		return Session{}, false, nil
	case errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD):
		sid, ok, err := sidByUserName(id)
		if err != nil || !ok {
			return Session{}, false, err
		}
		return Session{ID: id, UserSID: sid}, true, nil
	default:
		return Session{}, false, fmt.Errorf("sessiya %d tokeni olinmadi: %w", id, err)
	}
}

func tokenSID(tok windows.Token) (string, error) {
	u, err := tok.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("token foydalanuvchisi o'qilmadi: %w", err)
	}
	return u.User.Sid.String(), nil
}

// sidByUserName sessiyadagi `DOMEN\foydalanuvchi`ni SID'ga aylantiradi. Nom bo'sh — foydalanuvchi yo'q.
func sidByUserName(id uint32) (string, bool, error) {
	user, err := sessionString(id, wtsUserName)
	if err != nil || user == "" {
		return "", false, err
	}
	domain, err := sessionString(id, wtsDomainName)
	if err != nil {
		return "", false, err
	}
	account := user
	if domain != "" {
		account = domain + `\` + user
	}
	sid, _, _, err := windows.LookupSID("", account)
	if err != nil {
		return "", false, fmt.Errorf("%s SID'i topilmadi: %w", account, err)
	}
	return sid.String(), true, nil
}

func sessionString(id uint32, class uint32) (string, error) {
	var buf *uint16
	var n uint32
	r, _, e := procWTSQuerySessionInformationW.Call(
		0, // WTS_CURRENT_SERVER_HANDLE
		uintptr(id),
		uintptr(class),
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&n)),
	)
	if r == 0 {
		return "", fmt.Errorf("WTSQuerySessionInformation(%d, %d): %w", id, class, e)
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buf)))
	return windows.UTF16PtrToString(buf), nil
}

// StartAsUser exe'ni sessiya foydalanuvchisi nomidan, uning muhiti bilan, interaktiv ish stolida ishga tushiradi
// (Companion). CREATE_NO_WINDOW qo'yilmaydi: Companion GUI ilova, bayroq uning oynalariga ta'sir qilmasa ham bu
// yerda keraksiz. Token egasi s.UserSID bo'lmasa ErrSessionChanged.
func StartAsUser(s Session, exe string, args []string) (supervise.Proc, error) {
	if err := checkExe(exe); err != nil {
		return nil, err
	}
	var tok windows.Token
	if err := windows.WTSQueryUserToken(s.ID, &tok); err != nil {
		return nil, fmt.Errorf("sessiya %d tokeni olinmadi: %w", s.ID, err)
	}
	defer tok.Close()
	sid, err := tokenSID(tok)
	if err != nil {
		return nil, err
	}
	if sid != s.UserSID {
		return nil, fmt.Errorf("%w: kutilgan %s, sessiyada %s", ErrSessionChanged, s.UserSID, sid)
	}
	return createProcess(tok, exe, args, 0)
}

// StartAsSystemInSession exe'ni SYSTEM sifatida s sessiyasining interaktiv ish stolida ishga tushiradi (guard: past
// darajali klaviatura hook'i shu sessiya ish stolida bo'lishi kerak, lekin o'quvchi uni o'ldira olmasin).
// O'z tokenimiz nusxalanadi va unga sessiya raqami yoziladi (SetTokenInformation(TokenSessionId) SeTcbPrivilege
// talab qiladi — LocalSystem'da u yoqilgan). CREATE_NO_WINDOW qo'yiladi: helper konsol ilovasi, o'quvchi ish stolida
// konsol oynasi ochilmasin.
func StartAsSystemInSession(s Session, exe string, args []string) (supervise.Proc, error) {
	if err := checkExe(exe); err != nil {
		return nil, err
	}
	var self windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &self); err != nil {
		return nil, fmt.Errorf("o'z tokenimiz ochilmadi: %w", err)
	}
	defer self.Close()

	var tok windows.Token
	const access = windows.TOKEN_QUERY | windows.TOKEN_DUPLICATE | windows.TOKEN_ASSIGN_PRIMARY |
		windows.TOKEN_ADJUST_DEFAULT | windows.TOKEN_ADJUST_SESSIONID
	if err := windows.DuplicateTokenEx(self, access, nil, windows.SecurityImpersonation, windows.TokenPrimary, &tok); err != nil {
		return nil, fmt.Errorf("token nusxalanmadi: %w", err)
	}
	defer tok.Close()

	id := s.ID
	if err := windows.SetTokenInformation(tok, windows.TokenSessionId, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))); err != nil {
		return nil, fmt.Errorf("tokenga sessiya %d yozilmadi: %w", s.ID, err)
	}
	return createProcess(tok, exe, args, windows.CREATE_NO_WINDOW)
}

// checkExe faqat mutlaq yo'lni qabul qiladi: nisbiy nom PATH yoki joriy katalogdan qidirilmasin.
func checkExe(exe string) error {
	if !filepath.IsAbs(exe) {
		return fmt.Errorf("exe mutlaq yo'l bo'lishi kerak: %q", exe)
	}
	return nil
}

// createProcess tok nomidan jarayon yaratadi. Muhit bloki token egasiniki (CreateEnvironmentBlock, meros olinmaydi),
// joriy katalog — exe katalogi, dastaklar meros qilinmaydi. Ip dastagi darhol yopiladi, jarayon dastagi process'ga
// o'tadi (uni Wait yopadi).
func createProcess(tok windows.Token, exe string, args []string, flags uint32) (supervise.Proc, error) {
	exe16, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return nil, fmt.Errorf("exe yo'li yaroqsiz: %w", err)
	}
	cmd16, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{exe}, args...)))
	if err != nil {
		return nil, fmt.Errorf("argumentlar yaroqsiz: %w", err)
	}
	dir16, err := windows.UTF16PtrFromString(filepath.Dir(exe))
	if err != nil {
		return nil, fmt.Errorf("katalog yo'li yaroqsiz: %w", err)
	}
	desk16, err := windows.UTF16PtrFromString(desktop)
	if err != nil {
		return nil, err
	}

	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, tok, false); err != nil {
		return nil, fmt.Errorf("muhit bloki yaratilmadi: %w", err)
	}
	defer windows.DestroyEnvironmentBlock(env)

	si := windows.StartupInfo{Desktop: desk16}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	err = windows.CreateProcessAsUser(tok, exe16, cmd16, nil, nil, false,
		flags|windows.CREATE_UNICODE_ENVIRONMENT, env, dir16, &si, &pi)
	if err != nil {
		return nil, fmt.Errorf("%s ishga tushmadi: %w", exe, err)
	}
	_ = windows.CloseHandle(pi.Thread)
	return newProcess(pi.Process), nil
}

// ExitError jarayon nol bo'lmagan kod bilan tugadi.
type ExitError struct{ Code uint32 }

func (e *ExitError) Error() string { return fmt.Sprintf("jarayon %d kodi bilan tugadi", e.Code) }

// process jarayon dastagi ustidagi supervise.Proc. Wait dastakni yopadi, shuning uchun u bir marta chaqiriladi
// (ikkinchisi ErrWaited) va har jarayon uchun albatta chaqirilishi kerak (Supervisor shunday qiladi). Kill dastak
// yopilgach (yopilgan dastak raqami boshqa obyektga qayta berilgan bo'lishi mumkin) unga tegmaydi.
type process struct {
	mu     sync.Mutex
	h      windows.Handle
	waited bool // Wait boshlangan
	closed bool // dastak yopilgan, jarayon tugagan
}

func newProcess(h windows.Handle) *process { return &process{h: h} }

func (p *process) Wait() error {
	p.mu.Lock()
	if p.waited {
		p.mu.Unlock()
		return ErrWaited
	}
	p.waited = true
	h := p.h
	p.mu.Unlock()

	ev, err := windows.WaitForSingleObject(h, windows.INFINITE)
	var code uint32
	if err == nil && ev != windows.WAIT_OBJECT_0 {
		err = fmt.Errorf("WaitForSingleObject kutilmagan natija %#x", ev)
	}
	if err == nil {
		err = windows.GetExitCodeProcess(h, &code)
	}

	p.mu.Lock()
	p.closed = true
	_ = windows.CloseHandle(h)
	p.mu.Unlock()

	switch {
	case err != nil:
		return fmt.Errorf("jarayon kutilmadi: %w", err)
	case code != 0:
		return &ExitError{Code: code}
	default:
		return nil
	}
}

// Kill jarayonni to'xtatadi (TerminateProcess asinxron: tugashini Wait kutadi). Jarayon allaqachon tugagan bo'lsa nil.
func (p *process) Kill() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	if err := windows.TerminateProcess(p.h, killExitCode); err != nil {
		// Tugagan (lekin hali Wait yopmagan) jarayonda TerminateProcess ERROR_ACCESS_DENIED beradi.
		if ev, werr := windows.WaitForSingleObject(p.h, 0); werr == nil && ev == windows.WAIT_OBJECT_0 {
			return nil
		}
		return fmt.Errorf("jarayon to'xtatilmadi: %w", err)
	}
	return nil
}
