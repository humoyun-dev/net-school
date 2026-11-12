//go:build windows

package service

import (
	"errors"
	"testing"

	"github.com/humoyun-dev/net-school/native/helper/internal/session"
	"github.com/humoyun-dev/net-school/native/helper/internal/supervise"
)

// recordStart userStarter chaqiruvlarini yozib boradi va jarayon o'rniga xato qaytaradi.
type recordStart struct {
	exe  string
	opts []session.LaunchOptions
}

var errFakeStart = errors.New("soxta start")

func (r *recordStart) start(_ session.Session, exe string, _ []string, opts session.LaunchOptions) (supervise.Proc, error) {
	r.exe = exe
	r.opts = append(r.opts, opts)
	return nil, errFakeStart
}

// TestExplorerStartsAsPlainUserProcess explorer standart SD va to'liq muhit bilan (ShellLaunch) ishga tushadi.
func TestExplorerStartsAsPlainUserProcess(t *testing.T) {
	r := &recordStart{}
	// Bunday jarayon sessiyada yo'q: Ensure uni ishga tushirishga urinadi.
	e := explorerShell{exe: `C:\NetSchoolTest\nonexistent\explorer.exe`, start: r.start}
	err := e.Ensure(Session{ID: 1, UserSID: "S-1-5-21-1-2-3-1001"})
	if !errors.Is(err, errFakeStart) {
		t.Fatalf("Ensure = %v, soxta start xatosi kutilgan", err)
	}
	if len(r.opts) != 1 || r.opts[0] != session.ShellLaunch {
		t.Fatalf("explorer opts = %+v, ShellLaunch kutilgan", r.opts)
	}
}

// TestCompanionStartsProtected Companion himoyalangan SD va tozalangan muhit bilan (CompanionLaunch) ishga tushadi.
func TestCompanionStartsProtected(t *testing.T) {
	r := &recordStart{}
	l := companionLauncher(r.start, `C:\Program Files\NetSchool\companion\NetSchool.exe`)(Session{ID: 1, UserSID: "S-1-5-21-1-2-3-1001"})
	if _, err := l.Start(); !errors.Is(err, errFakeStart) {
		t.Fatalf("Start = %v", err)
	}
	if len(r.opts) != 1 || r.opts[0] != session.CompanionLaunch || !r.opts[0].SanitizedEnv() || r.opts[0].DefaultSecurity {
		t.Fatalf("companion opts = %+v, CompanionLaunch kutilgan", r.opts)
	}
	if r.exe != `C:\Program Files\NetSchool\companion\NetSchool.exe` {
		t.Fatalf("exe = %q", r.exe)
	}
}

func TestNewExplorerShellUsesSessionStart(t *testing.T) {
	if newExplorerShell(`C:\Windows\explorer.exe`).start == nil {
		t.Fatal("start bo'sh")
	}
}
