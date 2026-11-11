//go:build windows

package fsacl

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func requireElevated(t *testing.T) {
	t.Helper()
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("administrator huquqi kerak (CI runner elevated)")
	}
}

func assertHardened(t *testing.T, path string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	owner, _, err := sd.Owner()
	if err != nil || !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		t.Fatalf("%s: egasi %v (%v), want Administrators", path, owner, err)
	}
	control, _, _ := sd.Control()
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("%s: DACL himoyalanmagan (%s)", path, sd)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsWellKnown(windows.WinLocalSystemSid) && !sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
			t.Fatalf("%s: begona ACE %s (%s)", path, sid, sd)
		}
	}
}

func TestHardenSetsOwnerAndProtectedDACL(t *testing.T) {
	requireElevated(t)
	dir := filepath.Join(t.TempDir(), "helper")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "sub", "planted.json")
	if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	trusted, err := Harden(dir, Private)
	if err != nil {
		t.Fatalf("Harden: %v", err)
	}
	if trusted {
		t.Fatal("meros DACL'li katalog trusted deb topildi")
	}
	for _, p := range []string{dir, filepath.Join(dir, "sub"), file} {
		assertHardened(t, p)
	}
	// Ikkinchi marta: endi o'zimizniki.
	if trusted, err := Harden(dir, Private); err != nil || !trusted {
		t.Fatalf("qayta Harden: trusted=%v err=%v", trusted, err)
	}
	if err := Clear(dir); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("Clear'dan keyin %d element qoldi", len(entries))
	}
}

func TestHardenCreatesMissingDir(t *testing.T) {
	requireElevated(t)
	dir := filepath.Join(t.TempDir(), "a", "helper")
	trusted, err := Harden(dir, Private)
	if err != nil || trusted {
		t.Fatalf("trusted=%v err=%v", trusted, err)
	}
	assertHardened(t, dir)
}
