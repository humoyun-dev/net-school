package nativehost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func frame(t *testing.T, payload string) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := WriteFrame(&buf, []byte(payload)); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFramingRoundTrip(t *testing.T) {
	b := frame(t, `{"type":"applied"}`)
	if binary.LittleEndian.Uint32(b[:4]) != 18 {
		t.Fatalf("uzunlik = %d", binary.LittleEndian.Uint32(b[:4]))
	}
	got, err := ReadFrame(bytes.NewReader(b))
	if err != nil || string(got) != `{"type":"applied"}` {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestOversizedFrameRejected(t *testing.T) {
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], MaxMessage+1)
	if _, err := ReadFrame(bytes.NewReader(hdr[:])); err == nil {
		t.Fatal("katta ramka qabul qilindi")
	}
	if err := WriteFrame(io.Discard, make([]byte, MaxMessage+1)); err == nil {
		t.Fatal("katta xabar yozildi")
	}
}

func TestDetectsExtensionOriginArg(t *testing.T) {
	if !IsHostInvocation([]string{"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/", "--parent-window=0"}) {
		t.Fatal("Chrome chaqiruvi aniqlanmadi")
	}
	for _, args := range [][]string{nil, {"run"}, {"version", "chrome-extension://x/"}} {
		if IsHostInvocation(args) {
			t.Fatalf("%v host deb topildi", args)
		}
	}
}

// pipePair — Companion pipe'ining soxtasi (net.Pipe).
func TestRelaysBothDirections(t *testing.T) {
	hostSide, companion := net.Pipe()
	stdinR, stdinW := io.Pipe()
	var stdout syncBuffer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, stdinR, &stdout, func() (io.ReadWriteCloser, error) { return hostSide, nil }, time.Millisecond)
	}()

	// Companion → extension.
	go func() { _, _ = companion.Write([]byte(`{"type":"policy","lesson":null}` + "\n")) }()
	waitFor(t, func() bool { return stdout.Len() > 4 })
	msg, err := ReadFrame(bytes.NewReader(stdout.Bytes()))
	if err != nil || string(msg) != `{"type":"policy","lesson":null}` {
		t.Fatalf("extension'ga = %q %v", msg, err)
	}

	// Extension → Companion.
	lines := bufio.NewReader(companion)
	go func() { _, _ = stdinW.Write(frame(t, `{"type":"applied","browser":"chrome"}`)) }()
	line, err := lines.ReadString('\n')
	if err != nil || line != `{"type":"applied","browser":"chrome"}`+"\n" {
		t.Fatalf("Companion'ga = %q %v", line, err)
	}

	// Chrome stdin'ni yopdi → host tugaydi.
	stdinW.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run tugamadi")
	}
}

func TestUnavailableWhenDialFails(t *testing.T) {
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	var stdout syncBuffer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = Run(ctx, stdinR, &stdout, func() (io.ReadWriteCloser, error) { return nil, errors.New("yo'q") }, time.Hour)
	}()
	waitFor(t, func() bool { return stdout.Len() > 4 })
	msg, _ := ReadFrame(bytes.NewReader(stdout.Bytes()))
	if !strings.Contains(string(msg), `"unavailable"`) {
		t.Fatalf("xabar = %q", msg)
	}
}

func TestNonObjectFromExtensionIsDropped(t *testing.T) {
	hostSide, companion := net.Pipe()
	stdinR, stdinW := io.Pipe()
	var stdout syncBuffer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = Run(ctx, stdinR, &stdout, func() (io.ReadWriteCloser, error) { return hostSide, nil }, time.Millisecond)
	}()
	lines := bufio.NewReader(companion)
	go func() {
		_, _ = stdinW.Write(frame(t, "[1,2]\n"))
		_, _ = stdinW.Write(frame(t, `{"type":"applied"}`))
	}()
	line, err := lines.ReadString('\n')
	if err != nil || line != `{"type":"applied"}`+"\n" {
		t.Fatalf("Companion'ga = %q %v", line, err)
	}
}
