package browser

import (
	"reflect"
	"sort"
	"testing"
)

// fakeRegistry xotiradagi HKLM (kalit → nom → qiymat).
type fakeRegistry struct {
	values map[string]map[string]any
}

func newFake() *fakeRegistry { return &fakeRegistry{values: map[string]map[string]any{}} }

func (f *fakeRegistry) Read(key, name string) (any, bool, error) {
	v, ok := f.values[key][name]
	return v, ok, nil
}
func (f *fakeRegistry) Write(key, name string, v any) error {
	if f.values[key] == nil {
		f.values[key] = map[string]any{}
	}
	f.values[key][name] = v
	return nil
}
func (f *fakeRegistry) Delete(key, name string) error {
	delete(f.values[key], name)
	return nil
}
func (f *fakeRegistry) Names(key string) ([]string, error) {
	var out []string
	for n := range f.values[key] {
		out = append(out, n)
	}
	sort.Strings(out)
	return out, nil
}

func TestApplyWritesPlanAndReportsChanges(t *testing.T) {
	reg := newFake()
	plan := Plan(policy(true, "disabled", "allowed", chromeID, edgeID), manifest)
	changed, err := Apply(reg, plan)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(changed, []string{RuleIncognito, RuleManaged}) {
		t.Fatalf("changed = %v", changed)
	}
	if v, _, _ := reg.Read(ChromePolicies, "IncognitoModeAvailability"); v != uint32(1) {
		t.Fatalf("incognito = %v", v)
	}
	again, _ := Apply(reg, plan)
	if len(again) != 0 {
		t.Fatalf("o'zgarishsiz qayta qo'llash = %v", again)
	}
}

func TestApplyRepairsDrift(t *testing.T) {
	reg := newFake()
	plan := Plan(policy(true, "disabled", "allowed", chromeID, edgeID), manifest)
	if _, err := Apply(reg, plan); err != nil {
		t.Fatal(err)
	}
	_ = reg.Delete(ChromePolicies, "IncognitoModeAvailability")
	changed, err := Apply(reg, plan)
	if err != nil || !reflect.DeepEqual(changed, []string{RuleIncognito}) {
		t.Fatalf("changed = %v err = %v", changed, err)
	}
}

func TestApplyRemovesStaleForcelistEntries(t *testing.T) {
	reg := newFake()
	_ = reg.Write(ChromePolicies+`\ExtensionInstallForcelist`, "2", "evil;https://x")
	plan := Plan(policy(true, "allowed", "allowed", chromeID, ""), manifest)
	if _, err := Apply(reg, plan); err != nil {
		t.Fatal(err)
	}
	names, _ := reg.Names(ChromePolicies + `\ExtensionInstallForcelist`)
	if !reflect.DeepEqual(names, []string{"1"}) {
		t.Fatalf("forcelist = %v", names)
	}
}

func TestApplyUnmanagedRemovesOnlyOwnValues(t *testing.T) {
	reg := newFake()
	_ = reg.Write(ChromePolicies, "HomepageLocation", "https://school.uz") // begona siyosat
	if _, err := Apply(reg, Plan(policy(true, "disabled", "disabled", chromeID, edgeID), manifest)); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(reg, Plan(policy(false, "allowed", "allowed", "", ""), manifest)); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{ChromePolicies, EdgePolicies, ChromePolicies + `\ExtensionInstallForcelist`, ChromeHosts + `\` + HostName} {
		names, _ := reg.Names(k)
		if k == ChromePolicies {
			if !reflect.DeepEqual(names, []string{"HomepageLocation"}) {
				t.Fatalf("%s = %v", k, names)
			}
			continue
		}
		if len(names) != 0 {
			t.Fatalf("%s qoldi: %v", k, names)
		}
	}
}
