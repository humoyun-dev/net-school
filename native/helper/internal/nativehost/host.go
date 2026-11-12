// Package nativehost Chrome/Edge native messaging host'i (P2c): brauzer `netschool-helper.exe`ni
// `chrome-extension://<id>/` argumenti bilan o'quvchi nomidan ishga tushiradi. Host stdin/stdout ramkalarini
// (4 bayt little-endian uzunlik + JSON) Companion'ning o'quvchi sessiyasidagi pipe'idagi JSON qatorlarga ulaydi.
// Host o'zi siyosat bermaydi va saqlamaydi: faqat tekshirilgan Companion pipe'idan olib uzatadi.
package nativehost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// MaxMessage brauzer ↔ host xabarining yuqori chegarasi (Chrome host → extension uchun 1 MiB).
const MaxMessage = 1024 * 1024

// RetryInterval Companion pipe'i yo'q bo'lsa qayta ulanish oralig'i.
const RetryInterval = 5 * time.Second

// IsHostInvocation brauzer host'ni ishga tushirganmi: birinchi argument extension origin'i.
func IsHostInvocation(args []string) bool {
	return len(args) > 0 && strings.HasPrefix(args[0], "chrome-extension://")
}

func ReadFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if n > MaxMessage {
		return nil, fmt.Errorf("xabar juda katta: %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func WriteFrame(w io.Writer, payload []byte) error {
	if len(payload) > MaxMessage {
		return fmt.Errorf("xabar juda katta: %d", len(payload))
	}
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := w.Write(append(hdr[:], payload...)); err != nil {
		return err
	}
	return nil
}

// Run brauzer stdin'i yopilguncha (nil) yoki ctx bekor bo'lguncha ishlaydi. dial har urinishda Companion pipe'ini
// ochadi (Windows'da server jarayoni tekshiriladi); ulanmasa extension'ga `unavailable` yuboriladi.
func Run(ctx context.Context, stdin io.Reader, stdout io.Writer, dial func() (io.ReadWriteCloser, error), retry time.Duration) error {
	var outMu sync.Mutex
	toExtension := func(payload []byte) error {
		outMu.Lock()
		defer outMu.Unlock()
		return WriteFrame(stdout, payload)
	}
	fromExtension := make(chan []byte)
	stdinDone := make(chan error, 1)
	go func() {
		for {
			msg, err := ReadFrame(stdin)
			if err != nil {
				if errors.Is(err, io.EOF) {
					err = nil
				}
				stdinDone <- err
				return
			}
			select {
			case fromExtension <- msg:
			case <-ctx.Done():
				return
			}
		}
	}()

	for {
		conn, err := dial()
		if err != nil {
			if err := toExtension([]byte(`{"type":"unavailable"}`)); err != nil {
				return err
			}
			if done, err := wait(ctx, stdinDone, fromExtension, retry); done {
				return err
			}
			continue
		}
		lost := make(chan struct{})
		go func() {
			defer close(lost)
			sc := bufio.NewScanner(conn)
			sc.Buffer(make([]byte, 64*1024), MaxMessage+1)
			for sc.Scan() {
				if err := toExtension(sc.Bytes()); err != nil {
					return
				}
			}
		}()
		done, err := relay(ctx, conn, stdinDone, fromExtension, lost)
		conn.Close()
		<-lost
		if done {
			return err
		}
		if err := toExtension([]byte(`{"type":"unavailable"}`)); err != nil {
			return err
		}
		if done, err := wait(ctx, stdinDone, fromExtension, retry); done {
			return err
		}
	}
}

// relay ulanish tirik ekan extension xabarlarini Companion'ga yozadi. done=true — host tugashi kerak.
func relay(ctx context.Context, conn io.Writer, stdinDone <-chan error, in <-chan []byte, lost <-chan struct{}) (bool, error) {
	for {
		select {
		case <-ctx.Done():
			return true, ctx.Err()
		case err := <-stdinDone:
			return true, err
		case <-lost:
			return false, nil
		case msg := <-in:
			line, ok := compactObject(msg)
			if !ok {
				continue
			}
			if _, err := conn.Write(append(line, '\n')); err != nil {
				return false, nil
			}
		}
	}
}

// wait retry oralig'ida extension xabarlarini tashlab yuboradi (Companion yo'q).
func wait(ctx context.Context, stdinDone <-chan error, in <-chan []byte, retry time.Duration) (bool, error) {
	timer := time.NewTimer(retry)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return true, ctx.Err()
		case err := <-stdinDone:
			return true, err
		case <-in:
		case <-timer.C:
			return false, nil
		}
	}
}

// compactObject faqat JSON obyektni bitta qatorga siqadi (qator ajratgich ichida qolmasin).
func compactObject(msg []byte) ([]byte, bool) {
	trimmed := bytes.TrimSpace(msg)
	if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return nil, false
	}
	var out bytes.Buffer
	if err := json.Compact(&out, trimmed); err != nil {
		return nil, false
	}
	return out.Bytes(), true
}
