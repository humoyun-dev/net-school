package install

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/humoyun-dev/net-school/native/helper/internal/layout"
)

// aceRe SDDL ACE: (tur;bayroqlar;huquqlar;obyekt;meros obyekt;SID).
var aceRe = regexp.MustCompile(`\(([A-Z]+);([^;]*);([^;]*);([^;]*);([^;]*);([^)]*)\)`)

// rights SDDL huquq satrini ikki harfli tokenlarga ajratadi ("CCLCSW" → CC, LC, SW).
func rights(s string) []string {
	var out []string
	for i := 0; i+2 <= len(s); i += 2 {
		out = append(out, s[i:i+2])
	}
	return out
}

func TestServiceSDDLDeniesStopToUsers(t *testing.T) {
	const want = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"
	if ServiceSDDL != want {
		t.Fatalf("ServiceSDDL = %q, want %q", ServiceSDDL, want)
	}
	aces := aceRe.FindAllStringSubmatch(ServiceSDDL, -1)
	if len(aces) != 4 {
		t.Fatalf("ACE soni = %d, want 4", len(aces))
	}
	seen := map[string]bool{}
	for _, ace := range aces {
		typ, perms, sid := ace[1], ace[3], ace[6]
		seen[sid] = true
		if typ != "A" {
			t.Fatalf("%s: ACE turi %q, want A", sid, typ)
		}
		if sid != "IU" && sid != "SU" {
			continue
		}
		for _, r := range rights(perms) {
			switch r {
			case "RP", "WP", "DT", "SD", "WD", "WO", "DC":
				t.Fatalf("%s %s huquqiga ega (xizmatni boshqarish/o'chirish)", sid, r)
			}
		}
	}
	for _, sid := range []string{"SY", "BA", "IU", "SU"} {
		if !seen[sid] {
			t.Fatalf("SDDL'da %s yo'q", sid)
		}
	}
	// Boshqa hech kim (masalan WD — Everyone, AU) ro'yxatda yo'q.
	if len(seen) != 4 {
		t.Fatalf("kutilmagan SID'lar: %v", seen)
	}
}

func TestRecoveryActions(t *testing.T) {
	want := []int{1000, 1000, 5000}
	if len(RecoveryDelaysMs) != len(want) {
		t.Fatalf("RecoveryDelaysMs = %v, want %v", RecoveryDelaysMs, want)
	}
	for i, d := range RecoveryDelaysMs {
		if d != want[i] {
			t.Fatalf("RecoveryDelaysMs = %v, want %v", RecoveryDelaysMs, want)
		}
	}
	if RecoveryResetSeconds != 86400 {
		t.Fatalf("RecoveryResetSeconds = %d, want 86400", RecoveryResetSeconds)
	}
}

func TestInstallPathsAreUnderProgramFiles(t *testing.T) {
	p := layout.New(`C:\Program Files`, `C:\ProgramData`, `C:\Windows`)
	checks := map[string]string{
		p.InstallRoot:   `C:\Program Files\NetSchool`,
		p.HelperExe:     `C:\Program Files\NetSchool\helper\netschool-helper.exe`,
		p.CompanionDir:  `C:\Program Files\NetSchool\companion`,
		p.CompanionExe:  `C:\Program Files\NetSchool\companion\NetSchool Companion.exe`,
		p.DataRoot:      `C:\ProgramData\NetSchool`,
		p.HelperData:    `C:\ProgramData\NetSchool\helper`,
		p.HelperKey:     `C:\ProgramData\NetSchool\helper\helper.key`,
		p.DeviceJSON:    `C:\ProgramData\NetSchool\helper\device.json`,
		p.HubCA:         `C:\ProgramData\NetSchool\helper\hub-ca.pem`,
		p.Lock:          `C:\ProgramData\NetSchool\helper\lock.json`,
		p.PolicyJournal: `C:\ProgramData\NetSchool\helper\policy-journal.json`,
		p.CADJournal:    `C:\ProgramData\NetSchool\helper\cad-journal.json`,
		p.EnrollDir:     `C:\ProgramData\NetSchool\companion`,
		p.Explorer:      `C:\Windows\explorer.exe`,
	}
	for got, want := range checks {
		if got != want {
			t.Fatalf("yo'l %q, want %q", got, want)
		}
	}
	// Bajariladigan fayllar faqat Program Files ostida: C:\NetSchool (Authenticated Users yoza oladi) emas.
	for _, exe := range []string{p.HelperExe, p.CompanionExe} {
		if !strings.HasPrefix(exe, `C:\Program Files\NetSchool\`) {
			t.Fatalf("%q Program Files ostida emas", exe)
		}
	}
	// Oxirgi teskari chiziq ikki marta qo'shilmaydi.
	if q := layout.New(`D:\PF\`, `D:\PD\`, `D:\W\`); q.HelperExe != `D:\PF\NetSchool\helper\netschool-helper.exe` {
		t.Fatalf("HelperExe = %q", q.HelperExe)
	}
}

func TestHelperDeviceJSONKeepsOnlyHubFields(t *testing.T) {
	src := []byte(`{"hubOrigin":"https://hub.school.lan","deviceId":"0b6f3c1e-8d2a-4c7e-9f10-2a3b4c5d6e7f",` +
		`"siteId":"1b6f3c1e-8d2a-4c7e-9f10-2a3b4c5d6e7f","publicKey":"abc","enrolledAt":"2026-11-11T00:00:00Z"}`)
	out, err := HelperDeviceJSON(src)
	if err != nil {
		t.Fatalf("HelperDeviceJSON: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("natija JSON emas: %v", err)
	}
	if len(got) != 2 || got["hubOrigin"] != "https://hub.school.lan" || got["deviceId"] != "0b6f3c1e-8d2a-4c7e-9f10-2a3b4c5d6e7f" {
		t.Fatalf("natija = %v", got)
	}
	for _, bad := range []string{`{}`, `{"hubOrigin":"https://h","deviceId":"x"}`, `not json`} {
		if _, err := HelperDeviceJSON([]byte(bad)); err == nil {
			t.Fatalf("%s qabul qilindi", bad)
		}
	}
}
