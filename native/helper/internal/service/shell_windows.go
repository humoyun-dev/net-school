//go:build windows

package service

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/humoyun-dev/net-school/native/helper/internal/session"
	"github.com/humoyun-dev/net-school/native/helper/internal/supervise"
)

// userStarter — session.StartAsUser yoki Job.StartAsUser (testda soxta).
type userStarter func(s session.Session, exe string, args []string, opts session.LaunchOptions) (supervise.Proc, error)

// explorerShell Shell porti: sessiyada `%SystemRoot%\explorer.exe` (aynan shu yo'l) ishlamayotgan bo'lsa uni
// sessiya foydalanuvchisi nomidan ishga tushiradi. Explorer Job'ga qo'shilmaydi: xizmat to'xtasa ham o'quvchi
// ish stoli qolishi kerak. Explorer oddiy foydalanuvchi jarayoni (session.ShellLaunch): standart SD va to'liq
// muhit. Companion'ning himoyasi (tozalangan muhit, cheklangan DACL) bu yerda zarar: explorer'dan ochilgan har
// dastur muhitni meros oladi, o'quvchi esa o'z shell'ini Task Manager'dan qayta ishga tushira olmasdi.
type explorerShell struct {
	exe   string
	start userStarter
}

func newExplorerShell(exe string) explorerShell {
	return explorerShell{exe: exe, start: session.StartAsUser}
}

func (e explorerShell) Ensure(s Session) error {
	running, err := processInSession(s.ID, e.exe)
	if err != nil {
		return err
	}
	if running {
		return nil
	}
	p, err := e.start(toSession(s), e.exe, nil, session.ShellLaunch)
	if err != nil {
		return fmt.Errorf("explorer qayta ishga tushmadi: %w", err)
	}
	// Dastak Wait'da yopiladi; explorer'ni kuzatmaymiz.
	go func() { _ = p.Wait() }()
	return nil
}

// Running sessiyada `%SystemRoot%\explorer.exe` (aynan shu yo'l) ishlayaptimi.
func (e explorerShell) Running(s Session) (bool, error) { return processInSession(s.ID, e.exe) }

// processInSession sessiyada to'liq yo'li exe bo'lgan jarayon bormi.
func processInSession(id uint32, exe string) (bool, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, fmt.Errorf("jarayonlar ro'yxati olinmadi: %w", err)
	}
	defer windows.CloseHandle(snap)
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	base := strings.ToLower(filepath.Base(exe))
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		if strings.ToLower(windows.UTF16ToString(pe.ExeFile[:])) != base {
			continue
		}
		var sid uint32
		if windows.ProcessIdToSessionId(pe.ProcessID, &sid) != nil || sid != id {
			continue
		}
		if strings.EqualFold(imagePath(pe.ProcessID), exe) {
			return true, nil
		}
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return false, fmt.Errorf("jarayonlar ro'yxati o'qilmadi: %w", err)
	}
	return false, nil
}

func imagePath(pid uint32) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}
