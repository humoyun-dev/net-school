//go:build windows

package nativehost

import (
	"fmt"
	"io"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/humoyun-dev/net-school/native/helper/internal/layout"
	"github.com/humoyun-dev/net-school/native/helper/internal/procguard"
)

// ServiceName NetSchoolHelper xizmati (service.Name bilan bir xil; import aylanasidan qochish uchun takror).
const ServiceName = "NetSchoolHelper"

// PipeName Companion web pipe'i (apps/companion/src/main/web-pipe.ts webPipeName bilan bir xil).
func PipeName(session uint32) string { return fmt.Sprintf(`\\.\pipe\netschool-web-%d`, session) }

// Dial joriy sessiyadagi Companion pipe'ini ochadi va server jarayonini tekshiradi (ServerTrusted). Mijoz
// SECURITY_IDENTIFICATION bilan ulanadi: server host'ning tokenini taqlid qila olmaydi.
func Dial() (io.ReadWriteCloser, error) {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		return nil, err
	}
	name := PipeName(session)
	p, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IDENTIFICATION, 0)
	if err != nil {
		return nil, err
	}
	if err := verifyServer(h); err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	return os.NewFile(uintptr(h), name), nil
}

func verifyServer(h windows.Handle) error {
	var serverPID uint32
	if err := windows.GetNamedPipeServerProcessId(h, &serverPID); err != nil {
		return err
	}
	servicePID, err := helperServicePID()
	if err != nil {
		return err
	}
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return err
	}
	data, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return err
	}
	win, err := windows.KnownFolderPath(windows.FOLDERID_Windows, 0)
	if err != nil {
		return err
	}
	procs, err := procguard.Snapshot()
	if err != nil {
		return err
	}
	return ServerTrusted(procs, serverPID, servicePID, layout.New(pf, data, win).CompanionExe)
}

// helperServicePID SCM'dan (oddiy foydalanuvchi SERVICE_QUERY_STATUS huquqi bilan) xizmat PID'i; to'xtagan — 0.
func helperServicePID() (uint32, error) {
	m, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return 0, err
	}
	defer windows.CloseServiceHandle(m)
	name, _ := windows.UTF16PtrFromString(ServiceName)
	s, err := windows.OpenService(m, name, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return 0, err
	}
	defer windows.CloseServiceHandle(s)
	var st windows.SERVICE_STATUS_PROCESS
	var need uint32
	if err := windows.QueryServiceStatusEx(s, windows.SC_STATUS_PROCESS_INFO, (*byte)(unsafe.Pointer(&st)),
		uint32(unsafe.Sizeof(st)), &need); err != nil {
		return 0, err
	}
	if st.CurrentState != windows.SERVICE_RUNNING {
		return 0, nil
	}
	return st.ProcessId, nil
}
