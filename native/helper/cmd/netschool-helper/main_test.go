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

func TestParseHelperKeyArgs(t *testing.T) {
	token, rotate, err := parseHelperKeyArgs([]string{"--token", "nse_x"})
	if err != nil || token != "nse_x" || rotate {
		t.Fatalf("token=%q rotate=%v err=%v", token, rotate, err)
	}
	if _, rotate, err := parseHelperKeyArgs([]string{"--rotate", "--token", "nse_x"}); err != nil || !rotate {
		t.Fatalf("rotate=%v err=%v", rotate, err)
	}
	for _, bad := range [][]string{nil, {"--token"}, {"--token", ""}, {"--token", "a", "--token", "b"}, {"--x", "y"}} {
		if _, _, err := parseHelperKeyArgs(bad); err == nil {
			t.Fatalf("%q qabul qilindi", bad)
		}
	}
}

func TestParseSetHubArgs(t *testing.T) {
	a, err := parseSetHubArgs([]string{"--origin", "https://hub", "--device-id", "id", "--ca-file", `C:\ca.pem`})
	if err != nil || a.origin != "https://hub" || a.deviceID != "id" || a.caFile != `C:\ca.pem` {
		t.Fatalf("%+v %v", a, err)
	}
	if a, err := parseSetHubArgs([]string{"--device-id", "id", "--origin", "https://hub"}); err != nil || a.caFile != "" {
		t.Fatalf("%+v %v", a, err)
	}
	for _, bad := range [][]string{nil, {"--origin", "https://hub"}, {"--device-id", "id"}, {"--origin", "https://hub", "--device-id", "id", "--ca-file"}, {"--origin", "https://hub", "--device-id", "id", "--bogus", "x"}, {"--origin", "a", "--origin", "b", "--device-id", "id"}} {
		if _, err := parseSetHubArgs(bad); err == nil {
			t.Fatalf("%q qabul qilindi", bad)
		}
	}
}

func TestHelperKeyAndSetHubUsageExits2(t *testing.T) {
	for _, args := range [][]string{{"helper-key"}, {"set-hub", "--origin", "https://hub"}} {
		var stdout, stderr bytes.Buffer
		if code := run(args, &stdout, &stderr); code != 2 {
			t.Fatalf("%q: exit code = %d, want 2", args, code)
		}
	}
}
