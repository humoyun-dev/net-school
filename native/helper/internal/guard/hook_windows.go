//go:build windows

package guard

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/humoyun-dev/net-school/native/helper/internal/keys"
)

var (
	moduser32               = windows.NewLazySystemDLL("user32.dll")
	procSetWindowsHookExW   = moduser32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx = moduser32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx      = moduser32.NewProc("CallNextHookEx")
	procGetMessageW         = moduser32.NewProc("GetMessageW")
	procPeekMessageW        = moduser32.NewProc("PeekMessageW")
	procPostThreadMessageW  = moduser32.NewProc("PostThreadMessageW")
	hookProcs               = []*windows.LazyProc{
		procSetWindowsHookExW, procUnhookWindowsHookEx, procCallNextHookEx,
		procGetMessageW, procPeekMessageW, procPostThreadMessageW,
	}
)

// hookCallback hookProc'ning C ko'rsatkichi (NewCallback soni cheklangan: bir marta yaratiladi).
var hookCallback = windows.NewCallback(hookProc)

var errHookThreadExited = errors.New("hook oqimi tugagan")

// WinUser.h qiymatlari.
const (
	whKeyboardLL = 13
	wmQuit       = 0x0012
	wmKeyDown    = 0x0100
	wmKeyUp      = 0x0101
	wmSysKeyDown = 0x0104
	wmSysKeyUp   = 0x0105
	wmApp        = 0x8000
	pmNoRemove   = 0
)

// Hook oqimiga PostThreadMessageW bilan yuboriladigan buyruqlar.
const (
	msgInstall   = wmApp + 1
	msgUninstall = wmApp + 2
)

type kbdllhookstruct struct {
	vkCode      uint32
	scanCode    uint32
	flags       uint32
	time        uint32
	dwExtraInfo uintptr
}

type point struct{ x, y int32 }

type msg struct {
	hwnd     uintptr
	message  uint32
	wParam   uintptr
	lParam   uintptr
	time     uint32
	pt       point
	lPrivate uint32
}

// hookPolicy va callNextHookEx'ga faqat hook oqimi tegadi: callback shu oqimning GetMessageW'i ichida chaqiriladi,
// o'rnatish/olib tashlash ham shu oqimda. Shuning uchun qulf kerak emas (keys.Policy goroutine-xavfsiz emas).
var (
	hookPolicy     keys.Policy
	callNextHookEx uintptr
)

// hookProc WH_KEYBOARD_LL callback'i. Minimal: KBDLLHOOKSTRUCT'dan keys.Event, Policy.Handle, to'silsa 1, aks holda
// keyingi hook. Xotira ajratmaydi va qulf olmaydi: Windows javobni LowLevelHooksTimeout ichida kutadi, kechiksa hook'ni
// jimgina olib tashlaydi.
func hookProc(nCode, wParam, lParam uintptr) uintptr {
	if int32(nCode) >= 0 { // HC_ACTION
		// lParam KBDLLHOOKSTRUCT ko'rsatkichi (uintptr'dan unsafe.Pointer'ga go vet tan oladigan yo'l bilan).
		k := *(**kbdllhookstruct)(unsafe.Pointer(&lParam))
		down := wParam == wmKeyDown || wParam == wmSysKeyDown
		if down || wParam == wmKeyUp || wParam == wmSysKeyUp {
			if hookPolicy.Handle(keys.Event{VK: k.vkCode, Flags: k.flags, Down: down}) {
				return 1
			}
		}
	}
	r, _, _ := syscall.SyscallN(callNextHookEx, 0, nCode, wParam, lParam)
	return r
}

// hookThread xabar sikli turadigan, OS oqimiga bog'langan goroutine. Hook faqat shu oqimda o'rnatiladi va olinadi;
// boshqa goroutine'lar (pipe) unga PostThreadMessageW bilan buyruq yuboradi va javobni kanaldan kutadi.
type hookThread struct {
	mu      sync.Mutex // so'rovlar ketma-ket: bitta javob kanali
	tid     uint32
	replies chan error
	exited  chan struct{}
}

func startHookThread() (*hookThread, error) {
	for _, p := range hookProcs {
		if err := p.Find(); err != nil {
			return nil, err
		}
	}
	callNextHookEx = procCallNextHookEx.Addr()
	t := &hookThread{replies: make(chan error, 1), exited: make(chan struct{})}
	ready := make(chan struct{})
	go t.run(ready)
	select {
	case <-ready:
		return t, nil
	case <-t.exited:
		return nil, errHookThreadExited
	}
}

func (t *hookThread) run(ready chan<- struct{}) {
	// UnlockOSThread yo'q: goroutine tugaganda oqim ham tugaydi, hook boshqa goroutine'ga o'tib qolmaydi.
	runtime.LockOSThread()
	defer close(t.exited)

	var m msg
	// Oqimning xabar navbatini yaratadi: shundan keyin PostThreadMessageW yo'qolmaydi.
	_, _, _ = syscall.SyscallN(procPeekMessageW.Addr(), uintptr(unsafe.Pointer(&m)), 0, 0, 0, pmNoRemove)
	t.tid = windows.GetCurrentThreadId()
	close(ready)

	var hhk uintptr
	defer func() {
		if hhk != 0 {
			unhook(hhk)
		}
	}()
	for {
		r, _, _ := syscall.SyscallN(procGetMessageW.Addr(), uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 { // 0 — WM_QUIT, -1 — xato
			return
		}
		if m.hwnd != 0 {
			continue
		}
		switch m.message {
		case msgInstall:
			h, err := setHook()
			if err == nil {
				// Yangisi o'rnatilgach eskisi olinadi: oraliqda tugma himoyasiz qolmaydi. Callback faqat shu oqimning
				// GetMessageW'ida chaqiriladi, shuning uchun bitta hodisa ikki hook'dan o'tmaydi.
				if hhk != 0 {
					unhook(hhk)
				} else {
					hookPolicy.Reset()
				}
				hhk = h
			}
			t.replies <- err
		case msgUninstall:
			if hhk != 0 {
				unhook(hhk)
				hhk = 0
			}
			hookPolicy.Reset()
			t.replies <- nil
		}
	}
}

// setHook WH_KEYBOARD_LL o'rnatadi (faqat hook oqimida).
//
// Guard SYSTEM tokeni bilan (System integrity level) ishlaydi: o'quvchi jarayoni SendInput bilan yuborgan tugma
// LLKHF_INJECTED bilan birga LLKHF_LOWER_IL_INJECTED bilan keladi va keys.Policy uni to'sadi. Guard past darajada
// ishga tushirilsa bu bit qo'yilmaydi va soxta Win/Alt+Tab o'tib ketadi.
func setHook() (uintptr, error) {
	var mod windows.Handle
	if err := windows.GetModuleHandleEx(0, nil, &mod); err != nil {
		return 0, fmt.Errorf("modul dastagi olinmadi: %w", err)
	}
	h, _, e := syscall.SyscallN(procSetWindowsHookExW.Addr(), whKeyboardLL, hookCallback, uintptr(mod), 0)
	if h == 0 {
		return 0, fmt.Errorf("SetWindowsHookExW: %w", e)
	}
	return h, nil
}

func unhook(h uintptr) {
	_, _, _ = syscall.SyscallN(procUnhookWindowsHookEx.Addr(), h)
}

func (t *hookThread) request(id uint32) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	r, _, e := syscall.SyscallN(procPostThreadMessageW.Addr(), uintptr(t.tid), uintptr(id), 0, 0)
	if r == 0 {
		return fmt.Errorf("PostThreadMessageW: %w", e)
	}
	select {
	case err := <-t.replies:
		return err
	case <-t.exited:
		return errHookThreadExited
	}
}

// Install Hook interfeysi: hook'ni o'rnatadi yoki yangilaydi.
func (t *hookThread) Install() error { return t.request(msgInstall) }

// Uninstall Hook interfeysi: hook'ni oladi.
func (t *hookThread) Uninstall() { _ = t.request(msgUninstall) }

// stop xabar siklini tugatadi (hook olinadi) va oqim chiqishini kutadi.
func (t *hookThread) stop() {
	_, _, _ = syscall.SyscallN(procPostThreadMessageW.Addr(), uintptr(t.tid), wmQuit, 0, 0)
	<-t.exited
}

// Main `netschool-helper guard` rejimi: hook oqimini ishga tushiradi va ctx bekor qilinguncha xizmat pipe'iga
// ulanib turadi. Supervisor jarayonni TerminateProcess bilan to'xtatadi: Windows jarayon bilan birga hook'ni ham oladi.
func Main(ctx context.Context) error {
	t, err := startHookThread()
	if err != nil {
		return fmt.Errorf("hook oqimi ishga tushmadi: %w", err)
	}
	defer t.stop()
	g := &Guard{Dial: DialPipe, Hook: t}
	return g.Run(ctx)
}
