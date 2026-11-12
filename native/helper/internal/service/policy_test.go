package service

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

const h1 = "1111111111111111111111111111111111111111111111111111111111111111"

func rawPolicy(org int, managed bool, chrome string) []byte {
	ch := "null"
	if chrome != "" {
		ch = `"` + chrome + `"`
	}
	m := "false"
	if managed {
		m = "true"
	}
	return []byte(`{"baseline":{"revision":{"org":` + string(rune('0'+org)) + `,"site":0},"hash":"` + h1 + `",` +
		`"document":{"web":{"blocked":[]},"browser":{"managed":` + m + `,"incognito":"disabled","devTools":"allowed"},` +
		`"os":{"standardUser":true,"blockAppInstall":false,"lockWallpaper":false}}},` +
		`"extensions":{"chrome":` + ch + `,"edge":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`)
}

type policyWorld struct {
	raw       []byte
	fetchErr  error
	fetches   int
	cache     []byte
	receipts  []hub.Receipt
	changed   []string
	applies   int
	unmanaged []string
}

func (w *policyWorld) agent() *PolicyAgent {
	return NewPolicyAgent(PolicyDeps{
		Fetch: func(context.Context) ([]byte, error) {
			w.fetches++
			return w.raw, w.fetchErr
		},
		Report: func(_ context.Context, r hub.Receipt) error {
			w.receipts = append(w.receipts, r)
			return nil
		},
		LoadCache: func() ([]byte, error) { return w.cache, nil },
		SaveCache: func(b []byte) error { w.cache = b; return nil },
		Apply: func(hub.BaselinePolicy) ([]string, error) {
			w.applies++
			c := w.changed
			w.changed = nil
			return c, nil
		},
		Unmanaged: func(uint32) ([]string, error) { return w.unmanaged, nil },
	})
}

const chromeID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestPolicyAgentFetchesOnHintAndCaches(t *testing.T) {
	w := &policyWorld{raw: rawPolicy(1, true, chromeID), changed: []string{"browser.incognito", "browser.managed"}}
	a := w.agent()
	a.Hint(&hub.Revision{Org: 1})
	a.Step(context.Background(), 0, Session{ID: 1}, true)
	if w.fetches != 1 || string(w.cache) != string(w.raw) || w.applies != 1 {
		t.Fatalf("fetches=%d applies=%d cache=%q", w.fetches, w.applies, w.cache)
	}
	r := w.receipts[len(w.receipts)-1]
	want := map[string]hub.RuleResult{
		"browser.managed":     {State: hub.RuleApplied},
		"browser.onlyManaged": {State: hub.RuleApplied},
		"browser.incognito":   {State: hub.RuleApplied},
		"os.standardUser":     {State: hub.RuleUnsupported},
	}
	if !reflect.DeepEqual(r.Rules, want) || r.Repaired != nil || r.Revision != (hub.Revision{Org: 1}) {
		t.Fatalf("receipt = %+v", r)
	}
	// Bir xil ishora: qayta olinmaydi.
	a.Hint(&hub.Revision{Org: 1})
	a.Step(context.Background(), time.Second, Session{ID: 1}, true)
	if w.fetches != 1 {
		t.Fatalf("fetches = %d", w.fetches)
	}
}

func TestPolicyLoopRepairsDriftAndReportsIt(t *testing.T) {
	w := &policyWorld{raw: rawPolicy(1, true, chromeID), changed: []string{"browser.managed"}}
	a := w.agent()
	a.Hint(&hub.Revision{Org: 1})
	a.Step(context.Background(), 0, Session{ID: 1}, true)
	w.changed = []string{"browser.incognito"}
	a.Step(context.Background(), PolicyDriftInterval, Session{ID: 1}, true)
	r := w.receipts[len(w.receipts)-1]
	if !reflect.DeepEqual(r.Repaired, []string{"browser.incognito"}) {
		t.Fatalf("repaired = %v", r.Repaired)
	}
	n := len(w.receipts)
	a.Step(context.Background(), 2*PolicyDriftInterval, Session{ID: 1}, true)
	if len(w.receipts) != n {
		t.Fatal("o'zgarishsiz receipt qayta yuborildi")
	}
}

func TestPolicyLoopUsesCacheOffline(t *testing.T) {
	w := &policyWorld{cache: rawPolicy(2, true, chromeID), fetchErr: errors.New("offline")}
	a := w.agent()
	a.Step(context.Background(), 0, Session{ID: 1}, true)
	if w.applies != 1 {
		t.Fatalf("keshdagi siyosat qo'llanmadi: applies=%d", w.applies)
	}
}

func TestPolicyLoopReportsUnmanagedBrowser(t *testing.T) {
	w := &policyWorld{raw: rawPolicy(1, true, chromeID), unmanaged: []string{"firefox.exe"}}
	a := w.agent()
	a.Hint(&hub.Revision{Org: 1})
	a.Step(context.Background(), 0, Session{ID: 1}, true)
	got := w.receipts[len(w.receipts)-1].Rules["browser.onlyManaged"]
	if got != (hub.RuleResult{State: hub.RuleFailed, Code: "unmanaged_browser"}) {
		t.Fatalf("onlyManaged = %+v", got)
	}
}

func TestPolicyMissingExtensionIDFailsManaged(t *testing.T) {
	w := &policyWorld{raw: rawPolicy(1, true, "")}
	a := w.agent()
	a.Hint(&hub.Revision{Org: 1})
	a.Step(context.Background(), 0, Session{}, false)
	got := w.receipts[len(w.receipts)-1].Rules["browser.managed"]
	if got != (hub.RuleResult{State: hub.RuleFailed, Code: "extension_unpublished"}) {
		t.Fatalf("managed = %+v", got)
	}
}

func TestOSRulesUnsupported(t *testing.T) {
	w := &policyWorld{raw: rawPolicy(1, false, "")}
	a := w.agent()
	a.Hint(&hub.Revision{Org: 1})
	a.Step(context.Background(), 0, Session{}, false)
	rules := w.receipts[len(w.receipts)-1].Rules
	if len(rules) != 2 || rules["os.standardUser"].State != hub.RuleUnsupported || rules["browser.incognito"].State != hub.RuleApplied {
		t.Fatalf("rules = %+v", rules)
	}
}

func TestPolicyAgentFetchesNewRevisionPromptly(t *testing.T) {
	w := &policyWorld{raw: rawPolicy(1, false, "")}
	a := w.agent()
	a.Hint(&hub.Revision{Org: 1})
	a.Step(context.Background(), 0, Session{}, false)
	w.raw = rawPolicy(2, false, "")
	a.Hint(&hub.Revision{Org: 2})
	a.Step(context.Background(), 5*time.Second, Session{}, false)
	if w.fetches != 2 {
		t.Fatalf("yangi revision olinmadi: fetches=%d", w.fetches)
	}
	// Xatodan keyin darhol qayta urinmaydi (PolicyFetchRetry).
	w.fetchErr = errors.New("offline")
	a.Hint(&hub.Revision{Org: 3})
	a.Step(context.Background(), 10*time.Second, Session{}, false)
	a.Step(context.Background(), 11*time.Second, Session{}, false)
	if w.fetches != 3 {
		t.Fatalf("fetches=%d", w.fetches)
	}
	a.Step(context.Background(), 10*time.Second+PolicyFetchRetry, Session{}, false)
	if w.fetches != 4 {
		t.Fatalf("retry yo'q: fetches=%d", w.fetches)
	}
}
