package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/humoyun-dev/net-school/native/helper/internal/version"
)

func TestUnknownSubcommandExits2(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"nope"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "usage:") {
		t.Fatalf("stderr %q has no usage:", stderr.String())
	}
}

func TestNoSubcommandExits2(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run(nil, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "usage:") {
		t.Fatalf("stderr %q has no usage:", stderr.String())
	}
}

func TestVersionPrints(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"version"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0 (stderr %q)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), version.Version) {
		t.Fatalf("stdout %q does not contain version %q", stdout.String(), version.Version)
	}
}

func TestParseInstallArgs(t *testing.T) {
	dir, err := parseInstallArgs([]string{"--companion-dir", `C:\pkg\.`})
	if err != nil || dir != `C:\pkg\.` {
		t.Fatalf("dir=%q err=%v", dir, err)
	}
	for _, bad := range [][]string{nil, {"--companion-dir"}, {"--companion-dir", ""}, {"--bogus", "x"}, {"--companion-dir", "a", "b"}} {
		if _, err := parseInstallArgs(bad); err == nil {
			t.Fatalf("%q qabul qilindi", bad)
		}
	}
}

func TestInstallAndUninstallUsageExits2(t *testing.T) {
	for _, args := range [][]string{{"install"}, {"install", "--bogus"}, {"uninstall", "extra"}} {
		var stdout, stderr bytes.Buffer
		if code := run(args, &stdout, &stderr); code != 2 {
			t.Fatalf("%q: exit code = %d, want 2 (stderr %q)", args, code, stderr.String())
		}
	}
}
