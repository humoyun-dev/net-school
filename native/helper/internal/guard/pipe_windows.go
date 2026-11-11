//go:build windows

package guard

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// pipeBuffer pipe'ning har yo'nalishdagi buferi. Xabarlar ~20 bayt: bufer o'quvchi bir necha daqiqa javob bermasa
// ham yozuvchini bloklamaydi, StaleAfter undan ancha oldin ulanishni yopadi.
const pipeBuffer = 4096

// PipeListener xizmat tomonidagi pipe: bitta nusxa (bitta guard), faqat SYSTEM ulana oladi.
//
// Har nusxa FILE_FLAG_FIRST_PIPE_INSTANCE bilan yaratiladi: pipe nomini boshqa jarayon (o'quvchi) oldinroq egallagan
// bo'lsa yaratish xato beradi va xizmat soxta pipe'ga ishonmaydi. PIPE_REJECT_REMOTE_CLIENTS tarmoqdan ulanishni
// rad etadi. Ulanish overlapped: Accept ctx bilan bekor qilinadi, olingan *os.File Go runtime'ning IOCP'siga ulanadi
// va Close kutilayotgan o'qish/yozishni to'xtatadi.
type PipeListener struct {
	mu sync.Mutex
	h  windows.Handle // hali ulanmagan nusxa; 0 — keyingi Accept yangisini yaratadi
}

// Listen birinchi nusxani yaratadi (shu paytdan guard ulana oladi).
func Listen() (*PipeListener, error) {
	h, err := createInstance()
	if err != nil {
		return nil, err
	}
	return &PipeListener{h: h}, nil
}

func createInstance() (windows.Handle, error) {
	sd, err := windows.SecurityDescriptorFromString(PipeSDDL)
	if err != nil {
		return 0, fmt.Errorf("pipe SDDL o'qilmadi: %w", err)
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	name, err := windows.UTF16PtrFromString(PipeName)
	if err != nil {
		return 0, err
	}
	h, err := windows.CreateNamedPipe(name,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS,
		1, pipeBuffer, pipeBuffer, 0, &sa)
	if err != nil {
		return 0, fmt.Errorf("%s yaratilmadi: %w", PipeName, err)
	}
	return h, nil
}

// Accept guard ulanishini kutadi. Ulangan jarayon SYSTEM bo'lmasa (DACL buni allaqachon taqiqlaydi, bu ikkinchi
// to'siq) u uziladi va kutish davom etadi. Oldingi ulanish yopilgan bo'lishi kerak (bitta nusxa).
func (l *PipeListener) Accept(ctx context.Context) (io.ReadWriteCloser, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for {
		if l.h == 0 {
			h, err := createInstance()
			if err != nil {
				return nil, err
			}
			l.h = h
		}
		if err := connect(ctx, l.h); err != nil {
			switch {
			case ctx.Err() != nil:
				// Bekor qilingan nusxa ulanmagan holda qoladi va keyingi Accept'da qayta ishlatiladi.
				return nil, ctx.Err()
			case errors.Is(err, windows.ERROR_NO_DATA):
				// Mijoz ulanib, ConnectNamedPipe'gacha uzilgan: nusxani bo'shatib kutish davom etadi.
				_ = windows.DisconnectNamedPipe(l.h)
				continue
			}
			_ = windows.CloseHandle(l.h)
			l.h = 0
			return nil, err
		}
		if err := requireSystemPeer(l.h, windows.GetNamedPipeClientProcessId); err != nil {
			_ = windows.DisconnectNamedPipe(l.h)
			continue
		}
		f := os.NewFile(uintptr(l.h), PipeName)
		l.h = 0
		if f == nil {
			return nil, errors.New("pipe dastagi yaroqsiz")
		}
		return f, nil
	}
}

// Close kutilayotgan (ulanmagan) nusxani yopadi. Accept bilan bir vaqtda chaqirilmaydi: Accept'ni ctx to'xtatadi.
func (l *PipeListener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.h == 0 {
		return nil
	}
	err := windows.CloseHandle(l.h)
	l.h = 0
	return err
}

// connect ConnectNamedPipe'ni overlapped bajaradi va ctx bekor qilinsa CancelIoEx bilan to'xtatadi.
func connect(ctx context.Context, h windows.Handle) error {
	ev, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return fmt.Errorf("hodisa yaratilmadi: %w", err)
	}
	defer windows.CloseHandle(ev)
	ov := windows.Overlapped{HEvent: ev}

	err = windows.ConnectNamedPipe(h, &ov)
	switch {
	case err == nil, errors.Is(err, windows.ERROR_PIPE_CONNECTED):
		return nil
	case !errors.Is(err, windows.ERROR_IO_PENDING):
		return fmt.Errorf("ConnectNamedPipe: %w", err)
	}

	waited := make(chan struct{})
	defer close(waited)
	go func() {
		select {
		case <-ctx.Done():
			_ = windows.CancelIoEx(h, &ov)
		case <-waited:
		}
	}()
	var n uint32
	if err := windows.GetOverlappedResult(h, &ov, &n, true); err != nil {
		if errors.Is(err, windows.ERROR_OPERATION_ABORTED) && ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("ConnectNamedPipe: %w", err)
	}
	return nil
}

// DialPipe guard tomonidan xizmat pipe'iga ulanadi. Pipe egasi SYSTEM bo'lmasa (nomni boshqa jarayon egallagan)
// ulanish yopiladi. SECURITY_IDENTIFICATION: server guard nomidan ish bajara olmaydi (faqat kimligini biladi).
func DialPipe(context.Context) (io.ReadWriteCloser, error) {
	name, err := windows.UTF16PtrFromString(PipeName)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OVERLAPPED|windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IDENTIFICATION, 0)
	if err != nil {
		return nil, fmt.Errorf("%s ochilmadi: %w", PipeName, err)
	}
	if err := requireSystemPeer(h, windows.GetNamedPipeServerProcessId); err != nil {
		_ = windows.CloseHandle(h)
		return nil, err
	}
	f := os.NewFile(uintptr(h), PipeName)
	if f == nil {
		return nil, errors.New("pipe dastagi yaroqsiz")
	}
	return f, nil
}

// requireSystemPeer pipe'ning narigi tomonidagi jarayon LocalSystem ekanini tekshiradi.
func requireSystemPeer(h windows.Handle, peerPID func(windows.Handle, *uint32) error) error {
	var pid uint32
	if err := peerPID(h, &pid); err != nil {
		return fmt.Errorf("pipe'ning narigi jarayoni aniqlanmadi: %w", err)
	}
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return fmt.Errorf("jarayon %d ochilmadi: %w", pid, err)
	}
	defer windows.CloseHandle(p)
	var tok windows.Token
	if err := windows.OpenProcessToken(p, windows.TOKEN_QUERY, &tok); err != nil {
		return fmt.Errorf("jarayon %d tokeni ochilmadi: %w", pid, err)
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return fmt.Errorf("jarayon %d foydalanuvchisi o'qilmadi: %w", pid, err)
	}
	if !u.User.Sid.IsWellKnown(windows.WinLocalSystemSid) {
		return fmt.Errorf("pipe'ning narigi jarayoni %d SYSTEM emas (%s)", pid, u.User.Sid)
	}
	return nil
}
