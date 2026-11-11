//go:build windows

package session

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TestActiveConsoleOnRunner faqat chaqiruv ishlashini tekshiradi: CI runner'da konsolda foydalanuvchi bo'lmasligi
// mumkin (false ham qabul), runner SYSTEM emas (WTSQueryUserToken o'rniga zaxira yo'l ishlaydi).
func TestActiveConsoleOnRunner(t *testing.T) {
	s, ok, err := ActiveConsole()
	if err != nil {
		t.Fatalf("ActiveConsole: %v", err)
	}
	if !ok {
		if s != (Session{}) {
			t.Fatalf("foydalanuvchi yo'q, lekin Session = %+v", s)
		}
		t.Log("konsolda foydalanuvchi yo'q")
		return
	}
	if s.ID == noSession {
		t.Fatalf("ID = %#x", s.ID)
	}
	if !strings.HasPrefix(s.UserSID, "S-1-") {
		t.Fatalf("UserSID = %q", s.UserSID)
	}
	t.Logf("sessiya %d, foydalanuvchi %s", s.ID, s.UserSID)
}

func TestStartRejectsRelativeExe(t *testing.T) {
	s := Session{ID: 1, UserSID: "S-1-5-21-1-2-3-1001"}
	if _, err := StartAsUser(s, `companion\NetSchool.exe`, nil); err == nil {
		t.Fatal("StartAsUser nisbiy yo'lni qabul qildi")
	}
	if _, err := StartAsSystemInSession(s, `netschool-helper.exe`, []string{"guard"}); err == nil {
		t.Fatal("StartAsSystemInSession nisbiy yo'lni qabul qildi")
	}
}

// Quyidagi testlar process o'ramini (Wait/Kill) oddiy CreateProcess bilan ishga tushgan haqiqiy jarayonda
// tekshiradi: CreateProcessAsUser SYSTEM huquqini talab qiladi, runner'da u yo'q.

const helperEnv = "NETSCHOOL_SESSION_TEST_HELPER"

// TestHelperProcess test binarining o'zi bola jarayon sifatida ishga tushganda ishlaydi.
func TestHelperProcess(t *testing.T) {
	switch os.Getenv(helperEnv) {
	case "sleep":
		time.Sleep(time.Minute)
		os.Exit(0)
	case "exit3":
		os.Exit(3)
	}
}

func startHelper(t *testing.T, mode string) *process {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(helperEnv, mode)
	exe16, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		t.Fatal(err)
	}
	cmd16, err := windows.UTF16PtrFromString(windows.ComposeCommandLine([]string{exe, "-test.run=^TestHelperProcess$"}))
	if err != nil {
		t.Fatal(err)
	}
	var si windows.StartupInfo
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	if err := windows.CreateProcess(exe16, cmd16, nil, nil, false, windows.CREATE_NO_WINDOW, nil, nil, &si, &pi); err != nil {
		t.Fatalf("CreateProcess: %v", err)
	}
	_ = windows.CloseHandle(pi.Thread)
	return newProcess(pi.Process)
}

func TestProcessWaitReportsExitCode(t *testing.T) {
	p := startHelper(t, "exit3")
	err := p.Wait()
	var exit *ExitError
	if !errors.As(err, &exit) || exit.Code != 3 {
		t.Fatalf("Wait = %v, kutilgan chiqish kodi 3", err)
	}
	if err := p.Kill(); err != nil {
		t.Fatalf("tugagan jarayonda Kill: %v", err)
	}
	if err := p.Wait(); !errors.Is(err, ErrWaited) {
		t.Fatalf("ikkinchi Wait = %v", err)
	}
}

func TestProcessKillStopsRunningProcess(t *testing.T) {
	p := startHelper(t, "sleep")
	waited := make(chan error, 1)
	go func() { waited <- p.Wait() }()
	if err := p.Kill(); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	select {
	case err := <-waited:
		var exit *ExitError
		if !errors.As(err, &exit) || exit.Code != killExitCode {
			t.Fatalf("Wait = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Kill'dan keyin Wait qaytmadi")
	}
	if err := p.Kill(); err != nil {
		t.Fatalf("ikkinchi Kill: %v", err)
	}
}
