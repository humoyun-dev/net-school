//go:build !windows

package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestGuardRefusesOffWindows(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"guard"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "Windows") {
		t.Fatalf("stderr %q does not explain the OS limit", stderr.String())
	}
}

func TestRunRefusesOffWindows(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"run"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "Windows") {
		t.Fatalf("stderr %q does not explain the OS limit", stderr.String())
	}
}
