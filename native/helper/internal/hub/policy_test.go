package hub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

const policyJSON = `{
  "baseline": {
    "revision": {"org": 2, "site": 1},
    "hash": "` + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + `",
    "document": {
      "web": {"blocked": ["bad.com"]},
      "browser": {"managed": true, "incognito": "disabled", "devTools": "allowed"},
      "os": {"standardUser": true, "blockAppInstall": false, "lockWallpaper": false},
      "future": 1
    }
  },
  "extensions": {"chrome": "` + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" + `", "edge": null}
}`

func TestBaselinePolicyClient(t *testing.T) {
	pki := loopbackPKI(t)
	signer, key := helperSigner(t, time.Now)
	var uri string
	var headers http.Header
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri, headers = r.URL.RequestURI(), r.Header.Clone()
		io.WriteString(w, policyJSON)
	}))
	p, err := newTestClient(t, srv, pki.caPEM, signer).BaselinePolicy(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if uri != "/api/v1/device/helper/policy" {
		t.Fatalf("uri = %s", uri)
	}
	verifySignature(t, key, "GET", uri, headers, nil)
	if p.Revision != (Revision{Org: 2, Site: 1}) || p.Hash[:4] != "aaaa" {
		t.Fatalf("revision/hash = %+v %s", p.Revision, p.Hash)
	}
	if !p.Browser.Managed || p.Browser.Incognito != "disabled" || p.Browser.DevTools != "allowed" {
		t.Fatalf("browser = %+v", p.Browser)
	}
	if !p.OS.StandardUser || p.OS.BlockAppInstall {
		t.Fatalf("os = %+v", p.OS)
	}
	if p.Extensions.Chrome != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" || p.Extensions.Edge != "" {
		t.Fatalf("extensions = %+v", p.Extensions)
	}
}

func TestBaselinePolicyRejectsBadExtensionID(t *testing.T) {
	_, err := ParseBaselinePolicy([]byte(`{"baseline":{"revision":{"org":1,"site":0},"hash":"` +
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
		`","document":{"web":{"blocked":[]},"browser":{"managed":true,"incognito":"allowed","devTools":"allowed"},"os":{}}},"extensions":{"chrome":"x;evil","edge":null}}`))
	if err == nil {
		t.Fatal("noto'g'ri extension ID qabul qilindi")
	}
}

func TestLockStateCarriesBaselineRevision(t *testing.T) {
	pki := loopbackPKI(t)
	signer, _ := helperSigner(t, time.Now)
	body := `{"locked":false,"sequence":null,"leaseSeconds":120,"baseline":{"org":3,"site":0}}`
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
	state, err := newTestClient(t, srv, pki.caPEM, signer).LockState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state.Baseline == nil || *state.Baseline != (Revision{Org: 3}) {
		t.Fatalf("baseline = %+v", state.Baseline)
	}
}

func TestReportPolicyReceipt(t *testing.T) {
	pki := loopbackPKI(t)
	signer, key := helperSigner(t, time.Now)
	var uri, method string
	var headers http.Header
	var body []byte
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri, method, headers = r.URL.RequestURI(), r.Method, r.Header.Clone()
		body, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	err := newTestClient(t, srv, pki.caPEM, signer).ReportPolicyReceipt(context.Background(), Receipt{
		Revision: Revision{Org: 2, Site: 1},
		Hash:     "h",
		Rules:    map[string]RuleResult{"browser.managed": {State: RuleApplied}, "os.standardUser": {State: RuleUnsupported}},
		Repaired: []string{"browser.managed"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != "PUT" || uri != "/api/v1/device/helper/policy/receipt" {
		t.Fatalf("%s %s", method, uri)
	}
	verifySignature(t, key, method, uri, headers, body)
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	want := `{"hash":"h","layer":"baseline","repaired":["browser.managed"],"revision":{"org":2,"site":1},"rules":{"browser.managed":{"state":"applied"},"os.standardUser":{"state":"unsupported"}}}`
	canon, _ := json.Marshal(got)
	if string(canon) != want {
		t.Fatalf("body = %s", canon)
	}
}
