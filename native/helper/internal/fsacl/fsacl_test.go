package fsacl

import (
	"regexp"
	"strings"
	"testing"
)

var aceRe = regexp.MustCompile(`\(([A-Z]+);([^;]*);([^;]*);([^;]*);([^;]*);([^)]*)\)`)

func sids(t *testing.T, sddl string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, ace := range aceRe.FindAllStringSubmatch(sddl, -1) {
		if ace[1] != "A" {
			t.Fatalf("%s: faqat ruxsat ACE'lari kutiladi, %q bor", sddl, ace[1])
		}
		out[ace[6]] = ace[3]
	}
	return out
}

// Helper ma'lumot katalogi: egasi Administrators, meros o'chiq (P), faqat SYSTEM va Administrators (o'qish ham).
func TestPrivateSDDLGrantsOnlySystemAndAdmins(t *testing.T) {
	for _, s := range []string{Private.Dir, Private.File} {
		if !strings.HasPrefix(s, "O:BAD:P(") {
			t.Fatalf("%q: egasi BA va himoyalangan DACL emas", s)
		}
		got := sids(t, s)
		if len(got) != 2 || got["SY"] != "FA" || got["BA"] != "FA" {
			t.Fatalf("%q: ACE'lar %v", s, got)
		}
	}
}

// Program Files\NetSchool va Companion enrollment katalogi: foydalanuvchilar faqat o'qiydi va ishga tushiradi.
func TestReadableSDDLGivesUsersReadAndExecuteOnly(t *testing.T) {
	for _, s := range []string{Readable.Dir, Readable.File} {
		if !strings.HasPrefix(s, "O:BAD:P(") {
			t.Fatalf("%q: egasi BA va himoyalangan DACL emas", s)
		}
		got := sids(t, s)
		if len(got) != 3 || got["SY"] != "FA" || got["BA"] != "FA" || got["BU"] != "0x1200a9" {
			t.Fatalf("%q: ACE'lar %v", s, got)
		}
	}
}

// Fayl ACE'larida meros bayroqlari yo'q, katalognikida OICI bor.
func TestInheritFlags(t *testing.T) {
	for _, r := range []Rule{Private, Readable} {
		for _, ace := range aceRe.FindAllStringSubmatch(r.Dir, -1) {
			if ace[2] != "OICI" {
				t.Fatalf("katalog ACE %q: bayroq %q", ace[0], ace[2])
			}
		}
		for _, ace := range aceRe.FindAllStringSubmatch(r.File, -1) {
			if ace[2] != "" {
				t.Fatalf("fayl ACE %q: bayroq %q", ace[0], ace[2])
			}
		}
	}
}
