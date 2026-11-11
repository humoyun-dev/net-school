//go:build windows

package cad

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

var errProbe = errors.New("probe yiqildi")

// fakeRun skriptlarni yozib boradi va tayyor javob qaytaradi.
type fakeRun struct {
	out     string
	err     error
	scripts []string
}

func (f *fakeRun) run(_ context.Context, script string) (string, error) {
	f.scripts = append(f.scripts, script)
	return f.out, f.err
}

func backend(installed, running bool, svcErr error, r *fakeRun) *KeyboardFilter {
	return &KeyboardFilter{
		run: r.run,
		service: func(name string) (bool, bool, error) {
			if name != "MsKeyboardFilter" {
				panic("kutilmagan xizmat: " + name)
			}
			return installed, running, svcErr
		},
	}
}

func TestPowershellInvocationIsFixed(t *testing.T) {
	exe, err := powershellPath()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(exe) {
		t.Fatalf("powershell yo'li mutlaq emas: %q", exe)
	}
	if !strings.HasSuffix(strings.ToLower(exe), strings.ToLower(`\System32\WindowsPowerShell\v1.0\powershell.exe`)) {
		t.Fatalf("kutilmagan powershell yo'li: %q", exe)
	}
	if _, err := os.Stat(exe); err != nil {
		t.Fatalf("powershell.exe topilmadi: %v", err)
	}

	got := powershellArgs("SKRIPT")
	want := []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "SKRIPT"}
	if !slices.Equal(got, want) {
		t.Fatalf("argumentlar = %q, kutilgan %q", got, want)
	}
}

func TestScriptsAreSingleLineWithoutDoubleQuotes(t *testing.T) {
	// Buyruq qatoridagi `"` qochirilishiga va qator uzilishlariga tayanmaslik uchun.
	for name, script := range map[string]string{
		"feature": scriptFeatureState, "block": scriptBlock, "unblock": scriptUnblock,
	} {
		if strings.ContainsAny(script, "\"\r\n") {
			t.Errorf("%s skripti qo'sh tirnoq yoki qator uzilishi o'z ichiga oladi", name)
		}
	}
	for name, script := range map[string]string{"block": scriptBlock, "unblock": scriptUnblock} {
		for _, id := range []string{"'Ctrl+Alt+Del'", "'Win+L'", "WEKF_PredefinedKey", `root\standardcimv2\embedded`} {
			if !strings.Contains(script, id) {
				t.Errorf("%s skriptida %s yo'q", name, id)
			}
		}
	}
	if !strings.Contains(scriptBlock, "$k.Enabled = $true") || !strings.Contains(scriptUnblock, "$k.Enabled = $false") {
		t.Error("Block Enabled=$true, Unblock Enabled=$false qo'yishi kerak")
	}
	if strings.Contains(scriptBlock, "DisableKeyboardFilterForAdministrators") ||
		strings.Contains(scriptUnblock, "DisableKeyboardFilterForAdministrators") {
		t.Error("administrator sozlamasiga tegilmaydi")
	}
}

func TestBlockAndUnblockRunTheirFixedScripts(t *testing.T) {
	r := &fakeRun{}
	b := backend(true, true, nil, r)
	ctx := context.Background()

	if err := b.Block(ctx); err != nil {
		t.Fatal(err)
	}
	if err := b.Unblock(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(r.scripts, []string{scriptBlock, scriptUnblock}) {
		t.Fatalf("bajarilgan skriptlar kutilganidek emas: %q", r.scripts)
	}

	r.err = errProbe
	if err := b.Block(ctx); !errors.Is(err, errProbe) {
		t.Fatalf("Block xatosi o'ralishi kerak: %v", err)
	}
	if err := b.Unblock(ctx); !errors.Is(err, errProbe) {
		t.Fatalf("Unblock xatosi o'ralishi kerak: %v", err)
	}
}

func TestAvailableWithoutServiceIsEditionAndSkipsPowerShell(t *testing.T) {
	r := &fakeRun{out: "Enabled"}
	ok, reason := backend(false, false, nil, r).Available()
	if ok || reason != ReasonEdition {
		t.Fatalf("Available = (%v, %q), kutilgan (false, edition)", ok, reason)
	}
	if len(r.scripts) != 0 {
		t.Fatalf("xizmat yo'q bo'lsa PowerShell ishga tushmasligi kerak: %q", r.scripts)
	}
}

func TestAvailableFeatureStates(t *testing.T) {
	tests := []struct {
		name       string
		out        string
		running    bool
		wantOK     bool
		wantReason string // "" — tekshirilmaydi; "!edition" — edition bo'lmasligi kerak
	}{
		{"enabled and running", "Enabled\r\n", true, true, ""},
		{"feature disabled", "Disabled\r\n", true, false, ReasonEdition},
		{"pending reboot is not edition", "EnablePending\r\n", true, false, "!edition"},
		{"enabled but service stopped is not edition", "Enabled", false, false, "!edition"},
		{"garbage is not edition", "x; rm -rf /\r\n", true, false, "!edition"},
		{"empty is not edition", "", true, false, "!edition"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeRun{out: tc.out}
			ok, reason := backend(true, tc.running, nil, r).Available()
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, kutilgan %v (sabab %q)", ok, tc.wantOK, reason)
			}
			switch tc.wantReason {
			case "":
			case "!edition":
				if reason == "" || reason == ReasonEdition {
					t.Fatalf("sabab edition yoki bo'sh bo'lmasligi kerak: %q", reason)
				}
			default:
				if reason != tc.wantReason {
					t.Fatalf("sabab = %q, kutilgan %q", reason, tc.wantReason)
				}
			}
			if !slices.Equal(r.scripts, []string{scriptFeatureState}) {
				t.Fatalf("bajarilgan skriptlar: %q", r.scripts)
			}
			if strings.Contains(reason, "rm -rf") {
				t.Fatalf("PowerShell chiqishi sababga qo'shilmasligi kerak: %q", reason)
			}
		})
	}
}

func TestAvailableProbeErrorsAreNotEdition(t *testing.T) {
	ok, reason := backend(true, true, nil, &fakeRun{err: errProbe}).Available()
	if ok || reason == "" || reason == ReasonEdition || !strings.Contains(reason, errProbe.Error()) {
		t.Fatalf("PowerShell xatosi: (%v, %q)", ok, reason)
	}

	r := &fakeRun{out: "Enabled"}
	ok, reason = backend(false, false, errProbe, r).Available()
	if ok || reason == "" || reason == ReasonEdition || !strings.Contains(reason, errProbe.Error()) {
		t.Fatalf("xizmat tekshiruvi xatosi: (%v, %q)", ok, reason)
	}
	if len(r.scripts) != 0 {
		t.Fatal("xizmat tekshiruvi yiqilsa PowerShell ishga tushmasligi kerak")
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("  xato  \r\n", 512); got != "xato" {
		t.Fatalf("truncate = %q", got)
	}
	long := strings.Repeat("a", 600)
	if got := truncate(long, 512); len(got) != 512+3 || !strings.HasSuffix(got, "...") {
		t.Fatalf("uzun matn qisqartirilmadi: %d bayt", len(got))
	}
	// ToValidUTF8 ketma-ket yaroqsiz baytlarni bitta '?' bilan almashtiradi.
	if got := truncate("ab\xff\xfecd", 512); got != "ab?cd" {
		t.Fatalf("yaroqsiz UTF-8 almashtirilmadi: %q", got)
	}
}

// Haqiqiy xizmatlar boshqaruvchisi: MsKeyboardFilter bo'lmagan mashinada (CI runner, Pro/Home) xizmat topilmaydi va
// Available PowerShell'siz `edition` deydi. Xizmat bor mashinada test o'tkazib yuboriladi.
func TestRealServiceAbsentMeansEdition(t *testing.T) {
	installed, _, err := serviceState(keyboardFilterService)
	if err != nil {
		t.Fatalf("serviceState: %v", err)
	}
	if installed {
		t.Skip("MsKeyboardFilter xizmati bu mashinada bor")
	}
	if ok, reason := NewKeyboardFilter().Available(); ok || reason != ReasonEdition {
		t.Fatalf("Available = (%v, %q), kutilgan (false, edition)", ok, reason)
	}
}
