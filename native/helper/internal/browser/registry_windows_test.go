//go:build windows

package browser

import (
	"fmt"
	"reflect"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
)

func TestRegistryApplyRoundTrip(t *testing.T) {
	prefix := fmt.Sprintf(`Software\NetSchoolTest\browser-%d`, time.Now().UnixNano())
	t.Cleanup(func() { deleteTree(registry.CURRENT_USER, prefix) })
	reg := winRegistry{root: registry.CURRENT_USER, prefix: prefix}
	plan := Plan(policy(true, "disabled", "disabled", chromeID, edgeID), manifest)
	if _, err := Apply(reg, plan); err != nil {
		t.Fatal(err)
	}
	if v, ok, err := reg.Read(ChromePolicies, "IncognitoModeAvailability"); err != nil || !ok || v != uint32(1) {
		t.Fatalf("incognito = %v %v %v", v, ok, err)
	}
	if v, _, _ := reg.Read(ChromeHosts+`\`+HostName, ""); v != manifest {
		t.Fatalf("host = %v", v)
	}
	if again, err := Apply(reg, plan); err != nil || len(again) != 0 {
		t.Fatalf("again = %v %v", again, err)
	}
	if _, err := Apply(reg, Plan(policy(false, "allowed", "allowed", "", ""), manifest)); err != nil {
		t.Fatal(err)
	}
	if names, _ := reg.Names(ChromePolicies); !reflect.DeepEqual(names, []string{}) && len(names) != 0 {
		t.Fatalf("qoldi: %v", names)
	}
}

func deleteTree(root registry.Key, path string) {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS)
	if err == nil {
		subs, _ := k.ReadSubKeyNames(0)
		k.Close()
		for _, s := range subs {
			deleteTree(root, path+`\`+s)
		}
	}
	_ = registry.DeleteKey(root, path)
}
