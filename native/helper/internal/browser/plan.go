// Package browser Chrome va Edge'ning HKLM korporativ siyosatlarini bazaviy siyosat (`browser` bo'limi) bo'yicha
// yozadi: NetSchool extension'ini majburiy o'rnatish, boshqa extension'larni taqiqlash, mehmon/yangi profil,
// incognito va devtools'ni o'chirish, native messaging host'ni ro'yxatdan o'tkazish (P2c, ADR 0015).
//
// Egalik: `ExtensionInstallForcelist` va `ExtensionInstallBlocklist` kalitlari to'liq Helper'niki (boshqa
// qiymatlar o'chiriladi); qolgan nomlar faqat ownedValues ro'yxatidagilar. Boshqa siyosatlarga tegilmaydi.
package browser

import (
	"encoding/json"
	"sort"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

const (
	ChromePolicies  = `SOFTWARE\Policies\Google\Chrome`
	EdgePolicies    = `SOFTWARE\Policies\Microsoft\Edge`
	ChromeHosts     = `SOFTWARE\Google\Chrome\NativeMessagingHosts`
	EdgeHosts       = `SOFTWARE\Microsoft\Edge\NativeMessagingHosts`
	HostName        = "uz.netschool.web"
	ChromeUpdateURL = "https://clients2.google.com/service/update2/crx"
	EdgeUpdateURL   = "https://edge.microsoft.com/extensionwebstorebase/v1/crx"
)

// Qoida kalitlari (domain RuleKey bilan bir xil).
const (
	RuleManaged     = "browser.managed"
	RuleIncognito   = "browser.incognito"
	RuleDevTools    = "browser.devTools"
	RuleOnlyManaged = "browser.onlyManaged"
)

type Kind int

const (
	String Kind = iota
	DWord
)

// Value HKLM ostidagi bitta qiymat; Name "" — kalitning default qiymati.
type Value struct {
	Key, Name string
	Kind      Kind
	S         string
	D         uint32
	Rule      string
}

func (v Value) data() any {
	if v.Kind == DWord {
		return v.D
	}
	return v.S
}

type ref struct{ key, name string }

// ownedLists — to'liq egalik qilinadigan ro'yxat kalitlari.
var ownedLists = []string{
	ChromePolicies + `\ExtensionInstallForcelist`,
	EdgePolicies + `\ExtensionInstallForcelist`,
	ChromePolicies + `\ExtensionInstallBlocklist`,
	EdgePolicies + `\ExtensionInstallBlocklist`,
}

// ownedValues — Helper yozadigan va kerak bo'lmaganda o'chiradigan alohida qiymatlar (qoida bilan).
var ownedValues = map[ref]string{
	{ChromePolicies, "BrowserGuestModeEnabled"}:       RuleManaged,
	{EdgePolicies, "BrowserGuestModeEnabled"}:         RuleManaged,
	{ChromePolicies, "BrowserAddPersonEnabled"}:       RuleManaged,
	{EdgePolicies, "BrowserAddPersonEnabled"}:         RuleManaged,
	{ChromePolicies, "NativeMessagingUserLevelHosts"}: RuleManaged,
	{EdgePolicies, "NativeMessagingUserLevelHosts"}:   RuleManaged,
	{ChromeHosts + `\` + HostName, ""}:                RuleManaged,
	{EdgeHosts + `\` + HostName, ""}:                  RuleManaged,
	{ChromePolicies, "IncognitoModeAvailability"}:     RuleIncognito,
	{EdgePolicies, "InPrivateModeAvailability"}:       RuleIncognito,
	{ChromePolicies, "DeveloperToolsAvailability"}:    RuleDevTools,
	{EdgePolicies, "DeveloperToolsAvailability"}:      RuleDevTools,
}

// Plan siyosatdan kerakli qiymatlar ro'yxati (sof). managed=false bo'lsa extension siyosatlari yo'q, incognito va
// devtools esa alohida qoidalar sifatida qoladi.
func Plan(p hub.BaselinePolicy, hostManifest string) []Value {
	var out []Value
	if p.Browser.Managed {
		for _, b := range []struct{ policies, hosts, id, url string }{
			{ChromePolicies, ChromeHosts, p.Extensions.Chrome, ChromeUpdateURL},
			{EdgePolicies, EdgeHosts, p.Extensions.Edge, EdgeUpdateURL},
		} {
			if b.id != "" {
				out = append(out, Value{Key: b.policies + `\ExtensionInstallForcelist`, Name: "1", S: b.id + ";" + b.url, Rule: RuleManaged})
			}
			out = append(out,
				Value{Key: b.policies + `\ExtensionInstallBlocklist`, Name: "1", S: "*", Rule: RuleManaged},
				Value{Key: b.policies, Name: "BrowserGuestModeEnabled", Kind: DWord, D: 0, Rule: RuleManaged},
				Value{Key: b.policies, Name: "BrowserAddPersonEnabled", Kind: DWord, D: 0, Rule: RuleManaged},
				Value{Key: b.policies, Name: "NativeMessagingUserLevelHosts", Kind: DWord, D: 0, Rule: RuleManaged},
				Value{Key: b.hosts + `\` + HostName, Name: "", S: hostManifest, Rule: RuleManaged},
			)
		}
	}
	if p.Browser.Incognito == "disabled" {
		out = append(out,
			Value{Key: ChromePolicies, Name: "IncognitoModeAvailability", Kind: DWord, D: 1, Rule: RuleIncognito},
			Value{Key: EdgePolicies, Name: "InPrivateModeAvailability", Kind: DWord, D: 1, Rule: RuleIncognito},
		)
	}
	if p.Browser.DevTools == "disabled" {
		out = append(out,
			Value{Key: ChromePolicies, Name: "DeveloperToolsAvailability", Kind: DWord, D: 2, Rule: RuleDevTools},
			Value{Key: EdgePolicies, Name: "DeveloperToolsAvailability", Kind: DWord, D: 2, Rule: RuleDevTools},
		)
	}
	return out
}

// MissingExtensions managed bo'lsa ham do'kon ID'si yo'q brauzerlar (receipt: `extension_unpublished`).
func MissingExtensions(p hub.BaselinePolicy) []string {
	var out []string
	if !p.Browser.Managed {
		return nil
	}
	if p.Extensions.Chrome == "" {
		out = append(out, "chrome")
	}
	if p.Extensions.Edge == "" {
		out = append(out, "edge")
	}
	return out
}

// HostManifest native messaging host manifest'i (deterministik JSON). Faqat ID'si bor brauzerlar ruxsat oladi.
func HostManifest(helperExe string, ids hub.ExtensionIDs) []byte {
	origins := []string{}
	for _, id := range []string{ids.Chrome, ids.Edge} {
		if id != "" {
			origins = append(origins, "chrome-extension://"+id+"/")
		}
	}
	sort.Strings(origins)
	m := struct {
		Name           string   `json:"name"`
		Description    string   `json:"description"`
		Path           string   `json:"path"`
		Type           string   `json:"type"`
		AllowedOrigins []string `json:"allowed_origins"`
	}{HostName, "NetSchool web policy host", helperExe, "stdio", origins}
	out, _ := json.Marshal(m)
	return out
}

// Registry HKLM (64-bit ko'rinish) ustida minimal amallar; Windows'da registry_windows.go, testda soxta.
type Registry interface {
	Read(key, name string) (any, bool, error)
	Write(key, name string, v any) error
	Delete(key, name string) error
	Names(key string) ([]string, error)
}

// Apply rejani qo'llaydi va o'zgargan qoidalarni qaytaradi (saralangan). Egalik qilinmagan qiymatlarga tegmaydi.
func Apply(reg Registry, plan []Value) ([]string, error) {
	changed := map[string]bool{}
	want := map[ref]Value{}
	for _, v := range plan {
		want[ref{v.Key, v.Name}] = v
	}
	for _, key := range ownedLists {
		names, err := reg.Names(key)
		if err != nil {
			return nil, err
		}
		for _, n := range names {
			if _, ok := want[ref{key, n}]; !ok {
				if err := reg.Delete(key, n); err != nil {
					return nil, err
				}
				changed[RuleManaged] = true
			}
		}
	}
	for r, rule := range ownedValues {
		if _, ok := want[r]; ok {
			continue
		}
		if _, exists, err := reg.Read(r.key, r.name); err != nil {
			return nil, err
		} else if exists {
			if err := reg.Delete(r.key, r.name); err != nil {
				return nil, err
			}
			changed[rule] = true
		}
	}
	for _, v := range plan {
		cur, exists, err := reg.Read(v.Key, v.Name)
		if err != nil {
			return nil, err
		}
		if exists && cur == v.data() {
			continue
		}
		if err := reg.Write(v.Key, v.Name, v.data()); err != nil {
			return nil, err
		}
		changed[v.Rule] = true
	}
	out := make([]string, 0, len(changed))
	for r := range changed {
		out = append(out, r)
	}
	sort.Strings(out)
	return out, nil
}
