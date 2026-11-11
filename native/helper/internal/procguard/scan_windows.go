//go:build windows

package procguard

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Interval snapshot'lar orasidagi vaqt.
const Interval = 250 * time.Millisecond

// State qiymatlari (hub.ComponentActive/Off/Failed bilan bir xil).
const (
	StateActive = "active" // bloklash bor, oxirgi snapshot muvaffaqiyatli
	StateOff    = "off"    // bloklash yo'q (Start chaqirilmagan yoki Stop qilingan)
	StateFailed = "failed" // baseline yoki oxirgi snapshot olinmadi
)

// killExitCode to'xtatilgan jarayonning chiqish kodi.
const killExitCode = 1

// noSession ProcessIdToSessionId o'qilmagan jarayon sessiyasi: hech qachon o'quvchi sessiyasiga teng emas, shuning
// uchun bunday jarayonga tegilmaydi.
const noSession = 0xFFFFFFFF

// maxImagePath QueryFullProcessImageNameW buferining yuqori chegarasi (uzun yo'llar, belgilarda).
const maxImagePath = 32768

// Scanner bloklash paytida o'quvchi sessiyasini har Interval'da ko'rib chiqadi va Decide true degan jarayonlarni
// TerminateProcess bilan to'xtatadi. Start baseline'ni oladi, Stop to'xtatadi. Xizmat (Task 10) bloklash yoqilganda
// Start, o'chganda yoki sessiya almashganda Stop/Start chaqiradi.
//
// Xavfsizlik: faqat Start'ga berilgan sessiyadagi jarayonlar to'xtatiladi; PID 0, 4 va helper'ning o'zi hech qachon.
// Jarayon dastagi ochilgandan keyin sessiya, yaratilish vaqti va yo'l shu dastakdan o'qiladi va TerminateProcess
// ham shu dastakka beriladi: dastak ochiq turganda PID boshqa jarayonga berilmaydi, ya'ni qaror va o'ldirish bitta
// jarayonga tegishli.
//
// Start va Stop bitta goroutine'dan (xizmat Step tsikli) chaqirilishi kerak; State va Stats istalgan goroutine'dan.
//
// Dastak ochilmagan (ruxsat yo'q) yoki yo'li o'qilmagan jarayon: sessiyasi o'quvchiniki va baseline'da bo'lmasa
// o'ldirishga urinadi; urinish muvaffaqiyatsiz bo'lsa Stats'da hisoblanadi va LastError'ga yoziladi, guard to'xtamaydi.
type Scanner struct {
	allow Allow
	self  uint32

	mu       sync.Mutex
	cancel   context.CancelFunc
	done     chan struct{}
	state    string
	lastErr  error
	killed   uint64
	failed   uint64
	attempts map[procKey]bool // bu bloklashda hisoblangan jarayonlar (har biri bir marta sanaladi)
	stale    staleTracker     // Stale istisnosi har jarayonga bir scan (faqat loop goroutine'i ishlatadi)
}

// NewScanner ruxsat ro'yxatini %ProgramFiles% va %SystemRoot% (Known Folders) bo'yicha yasaydi; ishonchli ota —
// joriy (xizmat) jarayon.
func NewScanner() (*Scanner, error) {
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return nil, fmt.Errorf("%%ProgramFiles%% aniqlanmadi: %w", err)
	}
	root, err := windows.KnownFolderPath(windows.FOLDERID_Windows, 0)
	if err != nil {
		return nil, fmt.Errorf("%%SystemRoot%% aniqlanmadi: %w", err)
	}
	// Helper xizmatining o'zi ishonchli ota: Companion va guard'ni u ishga tushiradi (CreateProcessAsUser'da ota —
	// chaqiruvchi jarayon).
	self := windows.GetCurrentProcessId()
	return &Scanner{allow: DefaultAllow(pf, root, self), self: self, state: StateOff}, nil
}

// Start session uchun guard'ni yoqadi: hozirgi jarayonlar baseline bo'ladi. Ishlab turgan bo'lsa avval to'xtatadi
// (yangi baseline). Baseline olinmasa guard yoqilmaydi (bo'sh baseline sessiyadagi hamma narsani o'ldirardi) va
// holat StateFailed.
func (s *Scanner) Start(session uint32) error {
	s.Stop()
	procs, handles, err := snapshot(session, false)
	closeAll(handles)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.killed, s.failed, s.attempts, s.stale = 0, 0, map[procKey]bool{}, staleTracker{}
	if err != nil {
		s.state, s.lastErr = StateFailed, err
		return err
	}
	s.state, s.lastErr = StateActive, nil
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.cancel, s.done = cancel, done
	go s.loop(ctx, done, session, NewBaseline(procs, session))
	return nil
}

// Stop guard'ni o'chiradi va tsikl tugashini kutadi. Ishlamayotgan bo'lsa ham xavfsiz.
func (s *Scanner) Stop() {
	s.mu.Lock()
	cancel, done := s.cancel, s.done
	s.cancel, s.done = nil, nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	s.mu.Lock()
	s.state = StateOff
	s.mu.Unlock()
}

// State StateActive, StateOff yoki StateFailed.
func (s *Scanner) State() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// Stats joriy bloklashda to'xtatilgan va to'xtatib bo'lmagan jarayonlar soni va oxirgi xato.
func (s *Scanner) Stats() (killed, failed uint64, lastErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.killed, s.failed, s.lastErr
}

func (s *Scanner) loop(ctx context.Context, done chan struct{}, session uint32, baseline Baseline) {
	defer close(done)
	t := time.NewTicker(Interval)
	defer t.Stop()
	for {
		s.scan(session, baseline)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Scanner) scan(session uint32, baseline Baseline) {
	procs, handles, err := snapshot(session, true)
	defer closeAll(handles)
	if err != nil {
		s.mu.Lock()
		s.state, s.lastErr = StateFailed, err
		s.mu.Unlock()
		return
	}
	s.stale.Round(procs)
	live := baseline.Live(procs)
	type result struct {
		key procKey
		err error
	}
	var results []result
	for pid, p := range procs {
		if pid == 0 || pid == 4 || pid == s.self || p.Session != session {
			continue
		}
		if !Decide(p, session, live, procs, s.allow) {
			continue
		}
		key := procKey{pid, p.Created}
		h, ok := handles[pid]
		switch {
		case !ok:
			results = append(results, result{key, fmt.Errorf("jarayon %d (%s) ochilmadi", pid, p.Image)})
		default:
			if err := windows.TerminateProcess(h, killExitCode); err != nil && !exited(h) {
				results = append(results, result{key, fmt.Errorf("jarayon %d (%s) to'xtatilmadi: %w", pid, p.Image, err)})
			} else {
				results = append(results, result{key, nil})
			}
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.state = StateActive
	for _, r := range results {
		if r.err != nil {
			s.lastErr = r.err
		}
		if s.attempts[r.key] {
			continue
		}
		s.attempts[r.key] = true
		if r.err != nil {
			s.failed++
		} else {
			s.killed++
		}
	}
}

// exited jarayon allaqachon tugaganmi (tugayotgan jarayonda TerminateProcess ERROR_ACCESS_DENIED beradi).
func exited(h windows.Handle) bool {
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == windows.WAIT_OBJECT_0
}

// snapshot hamma jarayonlarni o'qiydi. withKill bo'lsa session'dagi jarayonlar uchun PROCESS_TERMINATE dastaklari
// qaytariladi (chaqiruvchi closeAll bilan yopadi); boshqa dastaklar darhol yopiladi.
func snapshot(session uint32, withKill bool) (map[uint32]Proc, map[uint32]windows.Handle, error) {
	// before'dan keyin yaratilgan jarayonning Toolhelp'dagi ParentPID'i eskirgan bo'lishi mumkin (inspect).
	before := time.Now()
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("jarayonlar snapshot'i olinmadi: %w", err)
	}
	defer windows.CloseHandle(snap)

	procs := map[uint32]Proc{}
	handles := map[uint32]windows.Handle{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	err = windows.Process32First(snap, &e)
	for err == nil {
		p, h := inspect(e.ProcessID, e.ParentProcessID, session, withKill, before)
		procs[p.PID] = p
		if h != 0 {
			handles[p.PID] = h
		}
		err = windows.Process32Next(snap, &e)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		closeAll(handles)
		return nil, nil, fmt.Errorf("jarayonlar ro'yxati o'qilmadi: %w", err)
	}
	return procs, handles, nil
}

// inspect bitta jarayonni o'qiydi. Dastak ochilsa sessiya qayta shu paytda o'qiladi: Toolhelp va OpenProcess orasida
// PID boshqa jarayonga berilgan bo'lsa ham natija dastakdagi jarayonniki. Qaytgan dastak (0 bo'lmasa) faqat
// withKill va session'dagi jarayon uchun.
//
// TOCTOU: ParentPID Toolhelp snapshot'idan, vaqt va yo'l esa keyin ochilgan dastakdan. Shu orada PID qayta berilgan
// bo'lsa, dastakdagi jarayon snapshot boshlanganidan (before) keyin yaratilgan bo'ladi va ParentPID unga tegishli
// emas: bunday jarayon Stale deb belgilanadi (Decide bu safar o'ldirmaydi va unga ota sifatida ishonmaydi, keyingi
// snapshot'da to'g'ri ParentPID bilan qayta ko'riladi).
func inspect(pid, ppid, session uint32, withKill bool, before time.Time) (Proc, windows.Handle) {
	p := Proc{PID: pid, ParentPID: ppid, Session: noSession}
	if pid == 0 || pid == 4 {
		p.Session = 0
		return p, 0
	}
	var sid uint32
	ours := windows.ProcessIdToSessionId(pid, &sid) == nil && sid == session
	access := uint32(windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.SYNCHRONIZE)
	if withKill && ours {
		access |= windows.PROCESS_TERMINATE
	}
	h, err := windows.OpenProcess(access, false, pid)
	if err != nil && access&windows.PROCESS_TERMINATE != 0 {
		// To'xtatish huquqi yo'q: hech bo'lmasa ma'lumotini o'qiymiz (qaror va hisob uchun).
		h, err = windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
		access = windows.PROCESS_QUERY_LIMITED_INFORMATION
	}
	if err != nil {
		// Dastak yo'q: sessiyani Toolhelp paytidagi o'qishdan olamiz (yo'l va vaqt noma'lum).
		if ours {
			p.Session = session
		}
		return p, 0
	}
	if windows.ProcessIdToSessionId(pid, &sid) == nil {
		p.Session = sid
	}
	var created, exit, kernel, user windows.Filetime
	if windows.GetProcessTimes(h, &created, &exit, &kernel, &user) == nil {
		p.Created = time.Unix(0, created.Nanoseconds())
		// Created >= before: yadro yaratish vaqti va time.Now() bir tick'ga tushishi mumkin, shuning uchun teng vaqt ham
		// Stale (aks holda aynan shu tick'da qayta berilgan PID o'tib ketardi). Soat orqaga ketsa Stale abadiy qolmasin:
		// scan'da staleTracker uni bir scan'dan keyin olib tashlaydi.
		p.Stale = !p.Created.Before(before)
	}
	p.Image = imagePath(h)
	if access&windows.PROCESS_TERMINATE != 0 && p.Session == session {
		return p, h
	}
	_ = windows.CloseHandle(h)
	return p, 0
}

// imagePath jarayonning to'liq Win32 yo'li, normallashtirilgan. O'qilmasa "".
func imagePath(h windows.Handle) string {
	for n := uint32(1024); n <= maxImagePath; n *= 2 {
		buf := make([]uint16, n)
		size := n
		err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size)
		if err == nil {
			return Normalize(windows.UTF16ToString(buf[:size]))
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) {
			return ""
		}
	}
	return ""
}

func closeAll(handles map[uint32]windows.Handle) {
	for _, h := range handles {
		_ = windows.CloseHandle(h)
	}
}
