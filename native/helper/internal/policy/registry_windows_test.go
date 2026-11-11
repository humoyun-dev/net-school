//go:build windows

package policy

import (
	"errors"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// testKey: testlar faqat shu kalitga (HKCU ostida) yozadi; haqiqiy `Policies`ga tegilmaydi.
const testKey = `Software\NetSchoolTest`

// unloadedSID hech qachon yuklanmagan hive uchun yaroqli SID.
const unloadedSID = "S-1-5-21-1-2-3-4"

func currentUserSID(t *testing.T) string {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatalf("joriy foydalanuvchi SID'i olinmadi: %v", err)
	}
	return user.User.Sid.String()
}

// deleteTestKey test kalitini ichma-ich kalitlari bilan o'chiradi (RegDeleteKey ichki kalitli kalitni o'chirmaydi,
// shuning uchun eng chuqurdan boshlanadi). Kalit yo'q bo'lsa xato emas.
func deleteTestKey() {
	for _, sub := range []string{`\Nested\Deeper`, `\Nested`, ``} {
		_ = registry.DeleteKey(registry.CURRENT_USER, testKey+sub)
	}
}

func TestRegistryRoundTripUnderTestKey(t *testing.T) {
	deleteTestKey()
	t.Cleanup(deleteTestKey)

	reg := NewRegistry()
	// HKU\<joriy SID> — HKCU bilan bir xil hive: HKU yo'li haqiqiy reyestr orqali sinaladi, natija HKCU'da tekshiriladi.
	root := userRoot(currentUserSID(t))

	mustRead := func(key, name string) *uint32 {
		t.Helper()
		v, err := reg.Read(root, key, name)
		if err != nil {
			t.Fatalf("Read(%s, %s): %v", key, name, err)
		}
		return v
	}

	if v := mustRead(testKey, "Probe"); v != nil {
		t.Fatalf("yo'q kalit: Read = %d, kutilgan nil", *v)
	}

	if err := reg.Write(root, testKey, "Probe", 1); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if v := mustRead(testKey, "Probe"); v == nil || *v != 1 {
		t.Fatalf("Write(1) dan keyin Read = %v", v)
	}
	// Xuddi shu qiymat HKCU orqali ham ko'rinadi, REG_DWORD sifatida.
	k, err := registry.OpenKey(registry.CURRENT_USER, testKey, registry.QUERY_VALUE)
	if err != nil {
		t.Fatalf("HKCU\\%s ochilmadi: %v", testKey, err)
	}
	got, typ, err := k.GetIntegerValue("Probe")
	k.Close()
	if err != nil || typ != registry.DWORD || got != 1 {
		t.Fatalf("HKCU'da Probe = (%d, tur %d, %v), kutilgan (1, REG_DWORD, nil)", got, typ, err)
	}

	// 0 va eng katta qiymat "yo'q" bilan adashmaydi.
	for _, want := range []uint32{0, 0xFFFFFFFF} {
		if err := reg.Write(root, testKey, "Probe", want); err != nil {
			t.Fatalf("Write(%d): %v", want, err)
		}
		if v := mustRead(testKey, "Probe"); v == nil || *v != want {
			t.Fatalf("Write(%d) dan keyin Read = %v", want, v)
		}
	}

	// Ichma-ich yo'q kalitlar Write bilan yaratiladi.
	if err := reg.Write(root, testKey+`\Nested\Deeper`, "Probe", 5); err != nil {
		t.Fatalf("ichma-ich Write: %v", err)
	}
	if v := mustRead(testKey+`\Nested\Deeper`, "Probe"); v == nil || *v != 5 {
		t.Fatalf("ichma-ich Read = %v", v)
	}

	if err := reg.Delete(root, testKey, "Probe"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if v := mustRead(testKey, "Probe"); v != nil {
		t.Fatalf("Delete'dan keyin Read = %d, kutilgan nil", *v)
	}
	// O'chirish takrorlanuvchan: qiymat ham, kalit ham yo'q bo'lsa xato emas.
	if err := reg.Delete(root, testKey, "Probe"); err != nil {
		t.Fatalf("takroriy Delete: %v", err)
	}
	if err := reg.Delete(root, testKey+`\NoSuchKey`, "Probe"); err != nil {
		t.Fatalf("yo'q kalitda Delete: %v", err)
	}

	// REG_DWORD bo'lmagan qiymat jimgina o'qilmaydi.
	hk, _, err := registry.CreateKey(registry.CURRENT_USER, testKey, registry.SET_VALUE)
	if err != nil {
		t.Fatal(err)
	}
	err = hk.SetStringValue("Text", "1")
	hk.Close()
	if err != nil {
		t.Fatal(err)
	}
	if v, err := reg.Read(root, testKey, "Text"); err == nil {
		t.Fatalf("REG_SZ qiymat uchun Read xato qaytarishi kerak edi, oldi %v", v)
	}
}

func TestRegistryReadsHKLM(t *testing.T) {
	reg := NewRegistry()
	// Faqat o'qish: Windows versiyasi (DWORD) va yo'q kalit.
	v, err := reg.Read("HKLM", `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "CurrentMajorVersionNumber")
	if err != nil || v == nil {
		t.Fatalf("HKLM Read = (%v, %v), kutilgan qiymat", v, err)
	}
	if v, err := reg.Read("HKLM", `SOFTWARE\NetSchoolDoesNotExist`, "X"); err != nil || v != nil {
		t.Fatalf("yo'q HKLM kaliti: Read = (%v, %v), kutilgan (nil, nil)", v, err)
	}
}

func TestRegistryUnloadedHiveIsAnError(t *testing.T) {
	reg := NewRegistry()
	root := userRoot(unloadedSID)
	if _, err := reg.Read(root, testKey, "Probe"); !errors.Is(err, errHiveNotLoaded) {
		t.Errorf("Read: %v, kutilgan errHiveNotLoaded", err)
	}
	if err := reg.Write(root, testKey, "Probe", 1); !errors.Is(err, errHiveNotLoaded) {
		t.Errorf("Write: %v, kutilgan errHiveNotLoaded", err)
	}
	if err := reg.Delete(root, testKey, "Probe"); !errors.Is(err, errHiveNotLoaded) {
		t.Errorf("Delete: %v, kutilgan errHiveNotLoaded", err)
	}
	// Write HKU ostida begona kalit yaratmagan bo'lishi kerak.
	if k, err := registry.OpenKey(registry.USERS, unloadedSID, registry.QUERY_VALUE); err == nil {
		k.Close()
		_ = registry.DeleteKey(registry.USERS, unloadedSID)
		t.Error("yuklanmagan hive uchun HKU ostida kalit yaratildi")
	}
}

func TestRegistryRejectsOtherRoots(t *testing.T) {
	reg := NewRegistry()
	for _, root := range []string{"", "HKCU", "HKCR", "HKU", `HKU\`, `HKU\.DEFAULT`, `HKU\` + unloadedSID + `\Software`, "hklm"} {
		if _, err := reg.Read(root, testKey, "Probe"); err == nil {
			t.Errorf("Read(%q) xato qaytarishi kerak edi", root)
		}
		if err := reg.Write(root, testKey, "Probe", 1); err == nil {
			t.Errorf("Write(%q) xato qaytarishi kerak edi", root)
		}
		if err := reg.Delete(root, testKey, "Probe"); err == nil {
			t.Errorf("Delete(%q) xato qaytarishi kerak edi", root)
		}
	}
	// Rad etilgan Write HKCU'da kalit qoldirmagan.
	if k, err := registry.OpenKey(registry.CURRENT_USER, testKey, registry.QUERY_VALUE); err == nil {
		k.Close()
		t.Error("rad etilgan root uchun kalit yaratildi")
		deleteTestKey()
	}
}
