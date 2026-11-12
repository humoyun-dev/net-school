package browser

import (
	"strings"
	"testing"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

const (
	chromeID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	edgeID   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	manifest = `C:\ProgramData\NetSchool\browser\uz.netschool.web.json`
)

func policy(managed bool, incognito, devtools string, chrome, edge string) hub.BaselinePolicy {
	return hub.BaselinePolicy{
		Browser:    hub.BrowserRules{Managed: managed, Incognito: incognito, DevTools: devtools},
		Extensions: hub.ExtensionIDs{Chrome: chrome, Edge: edge},
	}
}

func find(plan []Value, key, name string) (Value, bool) {
	for _, v := range plan {
		if v.Key == key && v.Name == name {
			return v, true
		}
	}
	return Value{}, false
}

func TestPlanManagedChromeAndEdge(t *testing.T) {
	plan := Plan(policy(true, "disabled", "disabled", chromeID, edgeID), manifest)
	want := []struct {
		key, name, s string
		d            uint32
		kind         Kind
		rule         string
	}{
		{ChromePolicies + `\ExtensionInstallForcelist`, "1", chromeID + ";" + ChromeUpdateURL, 0, String, RuleManaged},
		{EdgePolicies + `\ExtensionInstallForcelist`, "1", edgeID + ";" + EdgeUpdateURL, 0, String, RuleManaged},
		{ChromePolicies + `\ExtensionInstallBlocklist`, "1", "*", 0, String, RuleManaged},
		{EdgePolicies + `\ExtensionInstallBlocklist`, "1", "*", 0, String, RuleManaged},
		{ChromePolicies, "BrowserGuestModeEnabled", "", 0, DWord, RuleManaged},
		{EdgePolicies, "BrowserAddPersonEnabled", "", 0, DWord, RuleManaged},
		{ChromePolicies, "NativeMessagingUserLevelHosts", "", 0, DWord, RuleManaged},
		{ChromeHosts + `\` + HostName, "", manifest, 0, String, RuleManaged},
		{EdgeHosts + `\` + HostName, "", manifest, 0, String, RuleManaged},
		{ChromePolicies, "IncognitoModeAvailability", "", 1, DWord, RuleIncognito},
		{EdgePolicies, "InPrivateModeAvailability", "", 1, DWord, RuleIncognito},
		{ChromePolicies, "DeveloperToolsAvailability", "", 2, DWord, RuleDevTools},
		{EdgePolicies, "DeveloperToolsAvailability", "", 2, DWord, RuleDevTools},
	}
	for _, w := range want {
		got, ok := find(plan, w.key, w.name)
		if !ok {
			t.Fatalf("rejada yo'q: %s\\%s", w.key, w.name)
		}
		if got.Kind != w.kind || got.S != w.s || got.D != w.d || got.Rule != w.rule {
			t.Fatalf("%s\\%s = %+v", w.key, w.name, got)
		}
	}
}

func TestPlanUnmanagedIsEmpty(t *testing.T) {
	if plan := Plan(policy(false, "disabled", "disabled", chromeID, edgeID), manifest); len(plan) != 2+2 {
		// managed=false: faqat incognito va devtools (ikki brauzer), extension siyosatlari yo'q.
		t.Fatalf("plan = %+v", plan)
	}
	if plan := Plan(policy(false, "allowed", "allowed", "", ""), manifest); len(plan) != 0 {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestPlanWithoutIDsSkipsForcelist(t *testing.T) {
	plan := Plan(policy(true, "allowed", "allowed", "", edgeID), manifest)
	if _, ok := find(plan, ChromePolicies+`\ExtensionInstallForcelist`, "1"); ok {
		t.Fatal("ID'siz Chrome forcelist'ga yozildi")
	}
	if _, ok := find(plan, EdgePolicies+`\ExtensionInstallForcelist`, "1"); !ok {
		t.Fatal("Edge forcelist yo'q")
	}
	if missing := MissingExtensions(policy(true, "allowed", "allowed", "", edgeID)); len(missing) != 1 || missing[0] != "chrome" {
		t.Fatalf("missing = %v", missing)
	}
}

func TestHostManifestDeterministic(t *testing.T) {
	exe := `C:\Program Files\NetSchool\helper\netschool-helper.exe`
	a := string(HostManifest(exe, hub.ExtensionIDs{Chrome: chromeID}))
	b := string(HostManifest(exe, hub.ExtensionIDs{Chrome: chromeID}))
	if a != b {
		t.Fatal("manifest deterministik emas")
	}
	for _, part := range []string{`"name":"uz.netschool.web"`, `"type":"stdio"`, `"chrome-extension://` + chromeID + `/"`, `netschool-helper.exe`} {
		if !strings.Contains(a, part) {
			t.Fatalf("manifest'da %s yo'q: %s", part, a)
		}
	}
	if strings.Contains(a, "chrome-extension:///") {
		t.Fatalf("ID'siz brauzer allowed_origins'da: %s", a)
	}
}
