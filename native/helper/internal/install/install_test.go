package install

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"regexp"
	"strings"
	"testing"
	"time"

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
		p.InstallRoot:      `C:\Program Files\NetSchool`,
		p.HelperExe:        `C:\Program Files\NetSchool\helper\netschool-helper.exe`,
		p.CompanionDir:     `C:\Program Files\NetSchool\companion`,
		p.CompanionExe:     `C:\Program Files\NetSchool\companion\NetSchool Companion.exe`,
		p.DataRoot:         `C:\ProgramData\NetSchool`,
		p.HelperData:       `C:\ProgramData\NetSchool\helper`,
		p.HelperKey:        `C:\ProgramData\NetSchool\helper\helper.key`,
		p.HelperKeyPending: `C:\ProgramData\NetSchool\helper\helper.key.pending`,
		p.DeviceJSON:       `C:\ProgramData\NetSchool\helper\device.json`,
		p.HubCA:            `C:\ProgramData\NetSchool\helper\hub-ca.pem`,
		p.Lock:             `C:\ProgramData\NetSchool\helper\lock.json`,
		p.PolicyJournal:    `C:\ProgramData\NetSchool\helper\policy-journal.json`,
		p.CADJournal:       `C:\ProgramData\NetSchool\helper\cad-journal.json`,
		p.EnrollDir:        `C:\ProgramData\NetSchool\companion`,
		p.Explorer:         `C:\Windows\explorer.exe`,
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

const testCA = `-----BEGIN CERTIFICATE-----
MIIBfjCCASOgAwIBAgIUYr0QJp2u1x7oCk3oT6JxW0m3w8MwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTExMTAwMDAwMFoXDTM2MTEwODAw
MDAwMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE
-----END CERTIFICATE-----
`

const deviceID = "0b6f3c1e-8d2a-4c7e-9f10-2a3b4c5d6e7f"

func TestValidateHubWritesOnlyHubFields(t *testing.T) {
	out, err := ValidateHub("https://hub.school.lan", deviceID, nil)
	if err != nil {
		t.Fatalf("ValidateHub: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("natija JSON emas: %v", err)
	}
	if len(got) != 2 || got["hubOrigin"] != "https://hub.school.lan" || got["deviceId"] != deviceID {
		t.Fatalf("natija = %v", got)
	}
	for _, origin := range []string{"http://hub.school.lan", "https://hub.school.lan/", "https://u@hub", "https://hub?x=1", ""} {
		if _, err := ValidateHub(origin, deviceID, nil); err == nil {
			t.Fatalf("origin %q qabul qilindi", origin)
		}
	}
	if _, err := ValidateHub("https://hub.school.lan", "not-a-uuid", nil); err == nil {
		t.Fatal("yaroqsiz deviceId qabul qilindi")
	}
}

func TestValidateHubChecksTheCA(t *testing.T) {
	ca := selfSignedPEM(t)
	if _, err := ValidateHub("https://hub.school.lan", deviceID, ca); err != nil {
		t.Fatalf("haqiqiy CA rad etildi: %v", err)
	}
	for name, bad := range map[string][]byte{
		"bo'sh":         []byte(""),
		"PEM emas":      []byte("hello"),
		"buzilgan":      []byte(testCA),
		"kalit":         []byte("-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n"),
		"ortiqcha matn": append(append([]byte{}, ca...), []byte("junk")...),
		"juda katta":    make([]byte, MaxCABytes+1),
	} {
		if _, err := ValidateHub("https://hub.school.lan", deviceID, bad); err == nil {
			t.Fatalf("%s CA qabul qilindi", name)
		}
	}
}

func TestValidateToken(t *testing.T) {
	if err := ValidateToken("nse_" + strings.Repeat("A", 43)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "a\nb", "a b", strings.Repeat("x", 513), "ñ"} {
		if err := ValidateToken(bad); err == nil {
			t.Fatalf("%q qabul qilindi", bad)
		}
	}
}

func selfSignedPEM(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "hub"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

// Program Files'ga .cmd skriptlar (ular `%~dp0` ga bog'liq, u yerda buzilgan bo'lardi) va helper exe nusxasi tushmaydi.
func TestCompanionCopySkipsScriptsAndHelper(t *testing.T) {
	for rel, want := range map[string]bool{
		"enroll.cmd":                         true,
		"UNINSTALL.CMD":                      true,
		"netschool-helper.exe":               true,
		"NetSchool Companion.exe":            false,
		`resources\app\dist\main.cjs`:        false,
		`resources\app\netschool-helper.exe`: false,
	} {
		if got := SkipInCompanionCopy(rel); got != want {
			t.Fatalf("SkipInCompanionCopy(%q) = %v, want %v", rel, got, want)
		}
	}
}
