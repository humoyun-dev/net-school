//go:build windows

package fsacl

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
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

func securityOf(t *testing.T, path string) *windows.SECURITY_DESCRIPTOR {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return sd
}

func assertHardened(t *testing.T, path string) {
	t.Helper()
	sd := securityOf(t, path)
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

func write(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Meros DACL'li (ishonchsiz) katalog: ichidagilar o'chiriladi, katalog himoyalangan DACL bilan yangidan yaratiladi.
func TestHardenRecreatesUntrustedDir(t *testing.T) {
	requireElevated(t)
	dir := filepath.Join(t.TempDir(), "helper")
	write(t, filepath.Join(dir, "sub", "planted.json"))
	trusted, err := Harden(dir, Private)
	if err != nil || trusted {
		t.Fatalf("trusted=%v err=%v", trusted, err)
	}
	assertHardened(t, dir)
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("ishonchsiz katalogda %d element qoldi", len(entries))
	}
	// Endi bizniki: fayllar saqlanadi va handle orqali qayta o'rnatiladi.
	write(t, filepath.Join(dir, "lock.json"))
	if trusted, err := Harden(dir, Private); err != nil || !trusted {
		t.Fatalf("qayta Harden: trusted=%v err=%v", trusted, err)
	}
	assertHardened(t, filepath.Join(dir, "lock.json"))
}

func TestHardenCreatesMissingDir(t *testing.T) {
	requireElevated(t)
	dir := filepath.Join(t.TempDir(), "a")
	trusted, err := Harden(dir, Private)
	if err != nil || trusted {
		t.Fatalf("trusted=%v err=%v", trusted, err)
	}
	assertHardened(t, dir)
}

// Ishonchli katalogdagi hard link va symlink: havolaning o'zi o'chadi, nishonning ACL'i o'zgarmaydi.
func TestHardenRemovesLinksWithoutTouchingTargets(t *testing.T) {
	requireElevated(t)
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	target := filepath.Join(outside, "system.dll")
	write(t, target)
	before := securityOf(t, target).String()

	dir := filepath.Join(root, "helper")
	if _, err := Harden(dir, Private); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(target, filepath.Join(dir, "hard.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := Harden(dir, Private); err != nil {
		t.Fatalf("Harden: %v", err)
	}
	for _, name := range []string{"hard.json", "link"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s o'chirilmadi (%v)", name, err)
		}
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("nishon o'chib ketgan: %v", err)
	}
	if after := securityOf(t, target).String(); after != before {
		t.Fatalf("nishon ACL'i o'zgardi: %s → %s", before, after)
	}
}

// Katalogning o'zi junction/symlink bo'lsa: havola o'chadi, nishonga tegilmaydi.
func TestHardenReplacesLinkedDir(t *testing.T) {
	requireElevated(t)
	root := t.TempDir()
	target := filepath.Join(root, "target")
	write(t, filepath.Join(target, "keep.txt"))
	dir := filepath.Join(root, "helper")
	if err := os.Symlink(target, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := Harden(dir, Private); err != nil {
		t.Fatalf("Harden: %v", err)
	}
	assertHardened(t, dir)
	if _, err := os.Stat(filepath.Join(target, "keep.txt")); err != nil {
		t.Fatalf("nishon fayli yo'qoldi: %v", err)
	}
	if err := RemoveTree(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		t.Fatalf("RemoveTree: %v", err)
	}
}

// Ota katalog avval himoyalanadi (begona bo'lsa yangidan yaratiladi), keyin helper katalogi; ko'p fayl bir nechta
// ro'yxat sahifasida o'qiladi.
func TestHardenHelperDataHardensRootThenHelper(t *testing.T) {
	requireElevated(t)
	root := filepath.Join(t.TempDir(), "NetSchool")
	helper := filepath.Join(root, "helper")
	if _, err := HardenHelperData(root, helper); err != nil {
		t.Fatalf("HardenHelperData: %v", err)
	}
	for i := 0; i < 600; i++ {
		write(t, filepath.Join(helper, "f"+strings.Repeat("x", 100)+strconv.Itoa(i)))
	}
	trusted, err := HardenHelperData(root, helper)
	if err != nil || !trusted {
		t.Fatalf("trusted=%v err=%v", trusted, err)
	}
	if ok, err := IsTrustedDir(root); err != nil || !ok {
		t.Fatalf("root: %v %v", ok, err)
	}
	assertHardened(t, helper)
	assertHardened(t, filepath.Join(helper, "f"+strings.Repeat("x", 100)+"599"))
}
