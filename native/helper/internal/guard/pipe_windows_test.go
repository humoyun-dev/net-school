//go:build windows

package guard

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func skipIfSystem(t *testing.T) {
	t.Helper()
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatalf("joriy token o'qilmadi: %v", err)
	}
	if u.User.Sid.IsWellKnown(windows.WinLocalSystemSid) {
		t.Skip("test SYSTEM sifatida ishlayapti: DACL uni to'xtatmaydi")
	}
}

func mustListen(t *testing.T) *PipeListener {
	t.Helper()
	l, err := Listen()
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l
}

// CI runner admin, lekin SYSTEM emas: DACL `D:P(A;;GA;;;SY)` uni rad etadi. Accept esa ctx bilan to'xtaydi.
func TestPipeRejectsNonSystemClient(t *testing.T) {
	skipIfSystem(t)
	l := mustListen(t)

	if c, err := DialPipe(context.Background()); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		if c != nil {
			_ = c.Close()
		}
		t.Fatalf("DialPipe = %v, kutilgan ERROR_ACCESS_DENIED", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if c, err := l.Accept(ctx); !errors.Is(err, context.DeadlineExceeded) {
		if c != nil {
			_ = c.Close()
		}
		t.Fatalf("Accept = %v, kutilgan context.DeadlineExceeded", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("Accept ctx tugagach %v kutdi", d)
	}
	// Bekor qilingan nusxa qayta ishlatiladi: ikkinchi Accept ham to'xtaydi.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel2()
	if _, err := l.Accept(ctx2); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ikkinchi Accept = %v", err)
	}
}

func TestPipeDACLIsSystemOnly(t *testing.T) {
	l := mustListen(t)
	sd, err := windows.GetSecurityInfo(l.h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetSecurityInfo: %v", err)
	}
	s := sd.String()
	// Windows GA'ni pipe'ning aniq huquqlariga (FA) aylantirishi mumkin: faqat himoya va yagona SYSTEM ACE tekshiriladi.
	if !strings.HasPrefix(s, "D:P(") || strings.Count(s, "(") != 1 || !strings.HasSuffix(s, ";;;SY)") {
		t.Fatalf("pipe DACL = %q, kutilgan faqat SYSTEM (%s)", s, PipeSDDL)
	}
}

// Pipe nomini kimdir egallagan bo'lsa (bu yerda — birinchi Listen) xizmat ikkinchi nusxa yaratmaydi.
func TestSecondListenerIsRefused(t *testing.T) {
	mustListen(t)
	if l, err := Listen(); err == nil {
		_ = l.Close()
		t.Fatal("ikkinchi Listen muvaffaqiyatli bo'ldi, FILE_FLAG_FIRST_PIPE_INSTANCE kutilgan")
	}
}

// hookProc'ni to'g'ridan chaqirish: KBDLLHOOKSTRUCT o'qilishi va Policy natijasi (Win to'siladi).
func TestHookProcBlocksWinKey(t *testing.T) {
	t.Cleanup(hookPolicy.Reset)
	k := kbdllhookstruct{vkCode: 0x5b}
	if r := hookProc(0, wmKeyDown, uintptr(unsafe.Pointer(&k))); r != 1 {
		t.Fatalf("Win down: hookProc = %d, kutilgan 1", r)
	}
	if r := hookProc(0, wmKeyUp, uintptr(unsafe.Pointer(&k))); r != 1 {
		t.Fatalf("Win up: hookProc = %d, kutilgan 1 (to'silgan down'ning up'i ham)", r)
	}
}

// Hook oqimi o'rnatish/yangilash/olishni bajaradi. Runner sessiyasida LL hook o'rnatib bo'lmasa test o'tkaziladi.
func TestHookThreadInstallsRefreshesAndRemoves(t *testing.T) {
	th, err := startHookThread()
	if err != nil {
		t.Fatalf("startHookThread: %v", err)
	}
	defer th.stop()
	if err := th.Install(); err != nil {
		t.Skipf("bu sessiyada WH_KEYBOARD_LL o'rnatilmadi: %v", err)
	}
	if err := th.Install(); err != nil {
		t.Fatalf("yangilash: %v", err)
	}
	th.Uninstall()
	th.Uninstall() // o'rnatilmagan hook'ni olish xato emas
}

// Ulanish yopilgan oraliqda ham pipe nomi bo'shamasligi kerak: aks holda o'quvchi jarayoni nomni egallab, xizmatni
// guard'siz qoldirardi. Test runner SYSTEM emas, shuning uchun alohida nom va joriy foydalanuvchiga ruxsat beruvchi
// DACL ishlatiladi (mexanizm bir xil, faqat DACL boshqa).
func TestPipeNameNeverLapsesAcrossConnections(t *testing.T) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf(`\\.\pipe\netschool-helper-guard-test-%d`, os.Getpid())
	sddl := "D:P(A;;GA;;;SY)(A;;GA;;;" + u.User.Sid.String() + ")"
	l, err := listen(name, sddl, func(windows.Handle) error { return nil })
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })

	dial := func() windows.Handle {
		t.Helper()
		n, _ := windows.UTF16PtrFromString(name)
		h, err := windows.CreateFile(n, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
		if err != nil {
			t.Fatalf("mijoz ulanmadi: %v", err)
		}
		return h
	}
	for i := range 2 {
		client := dial()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		conn, err := l.Accept(ctx)
		cancel()
		if err != nil {
			t.Fatalf("Accept %d: %v", i, err)
		}
		_ = windows.CloseHandle(client)
		_ = conn.Close()
		// Ulanish yopildi: "o'quvchi" nomni egallashga urinadi.
		if sq, err := listen(name, sddl, func(windows.Handle) error { return nil }); err == nil {
			_ = sq.Close()
			t.Fatalf("ulanish %d yopilgach pipe nomi bo'shab qoldi (ikkinchi listen muvaffaqiyatli)", i)
		}
	}
	if err := l.LastError(); err != nil {
		t.Fatalf("LastError = %v", err)
	}
}
