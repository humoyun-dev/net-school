//go:build windows

package nativehost

import (
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Testning o'zi pipe server: image Companion emas → Dial rad etadi.
func TestRejectsForeignPipeServer(t *testing.T) {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		t.Fatal(err)
	}
	name, _ := windows.UTF16PtrFromString(PipeName(session))
	h, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX, windows.PIPE_TYPE_BYTE|windows.PIPE_WAIT, 1, 4096, 4096, 0, nil)
	if err != nil {
		t.Skipf("pipe ochilmadi (nom band?): %v", err)
	}
	defer windows.CloseHandle(h)
	go func() { _ = windows.ConnectNamedPipe(h, nil) }()
	time.Sleep(50 * time.Millisecond)
	if conn, err := Dial(); err == nil {
		conn.Close()
		t.Fatal("begona pipe server qabul qilindi")
	}
}
