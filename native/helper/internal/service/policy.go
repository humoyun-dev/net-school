package service

import (
	"context"
	"reflect"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

// P2c: bazaviy siyosat agenti. Siyosatni Companion'dan emas, hub'dan o'z kaliti bilan oladi, helper katalogida
// keshlaydi (oflayn ham amalda), brauzer siyosatlarini qo'llaydi va PolicyDriftInterval'da drift'ni tuzatadi.
const (
	// PolicyDriftInterval qo'llangan qiymatlarni qayta tekshirish (o'quvchi/admin registrni o'zgartirgan bo'lsa).
	PolicyDriftInterval = 60 * time.Second
	// PolicyRefreshInterval ishorasiz ham to'liq siyosatni qayta olish.
	PolicyRefreshInterval = 300 * time.Second
	// PolicyFetchRetry olish xatosidan keyingi qayta urinish.
	PolicyFetchRetry = 30 * time.Second
	// PolicyReceiptRefresh o'zgarmagan receipt'ni qayta yuborish (hub "tirik" ekanini ko'rsin).
	PolicyReceiptRefresh = 300 * time.Second
)

// PolicyDeps — agent portlari (Windows'da hub mijozi, DirGate'li fayl, registr; testda soxta).
type PolicyDeps struct {
	Fetch     func(ctx context.Context) ([]byte, error)
	Report    func(ctx context.Context, r hub.Receipt) error
	LoadCache func() ([]byte, error)
	SaveCache func([]byte) error
	// Apply rejani qo'llaydi va o'zgargan qoidalarni qaytaradi.
	Apply     func(p hub.BaselinePolicy) ([]string, error)
	Unmanaged func(session uint32) ([]string, error)
	Log       func(format string, args ...any)
}

type PolicyAgent struct {
	d PolicyDeps

	loaded    bool
	current   *hub.BaselinePolicy
	want      *hub.Revision
	needFetch bool

	// retryAt — xatodan keyingi eng erta urinish; refreshAt — ishorasiz davriy qayta olish.
	retryAt, refreshAt, nextApply, nextReport time.Duration
	appliedHash                               string
	lastApply                                 []string
	applyErr                                  error
	repaired                                  []string
	lastSent                                  *hub.Receipt
}

func NewPolicyAgent(d PolicyDeps) *PolicyAgent {
	if d.Log == nil {
		d.Log = func(string, ...any) {}
	}
	return &PolicyAgent{d: d}
}

// Hint lock-state'dagi revision: farq qilsa keyingi Step to'liq siyosatni oladi.
func (a *PolicyAgent) Hint(rev *hub.Revision) {
	if rev == nil {
		return
	}
	a.want = rev
	if a.current == nil || a.current.Revision != *rev {
		a.needFetch = true
	}
}

// Step har xizmat Step'ida.
func (a *PolicyAgent) Step(ctx context.Context, now time.Duration, s Session, hasSession bool) {
	if !a.loaded {
		a.loaded = true
		if raw, err := a.d.LoadCache(); err == nil && len(raw) > 0 {
			if p, err := hub.ParseBaselinePolicy(raw); err == nil {
				a.current = &p
				a.nextApply = 0
			}
		}
		if a.current == nil {
			a.needFetch = true
		}
	}
	if now >= a.retryAt && (a.needFetch || now >= a.refreshAt) {
		a.fetch(ctx, now)
	}
	if a.current == nil {
		return
	}
	if now >= a.nextApply {
		a.nextApply = now + PolicyDriftInterval
		changed, err := a.d.Apply(*a.current)
		a.applyErr = err
		if err != nil {
			a.d.Log("brauzer siyosati qo'llanmadi: %v", err)
		}
		if err == nil && a.appliedHash == a.current.Hash && len(changed) > 0 {
			a.repaired = changed
			a.d.Log("brauzer siyosati drift'i tuzatildi: %v", changed)
		}
		if err == nil {
			a.appliedHash = a.current.Hash
		}
	}
	a.report(ctx, now, s, hasSession)
}

func (a *PolicyAgent) fetch(ctx context.Context, now time.Duration) {
	raw, err := a.d.Fetch(ctx)
	var p hub.BaselinePolicy
	if err == nil {
		p, err = hub.ParseBaselinePolicy(raw)
	}
	if err != nil {
		a.retryAt = now + PolicyFetchRetry
		a.d.Log("bazaviy siyosat olinmadi: %v", err)
		return
	}
	a.needFetch = false
	a.refreshAt = now + PolicyRefreshInterval
	if err := a.d.SaveCache(raw); err != nil {
		a.d.Log("bazaviy siyosat keshlanmadi: %v", err)
	}
	if a.current == nil || a.current.Hash != p.Hash || a.current.Revision != p.Revision {
		a.nextApply = now
	}
	a.current = &p
}

func (a *PolicyAgent) rules(s Session, hasSession bool) map[string]hub.RuleResult {
	p := a.current
	rules := map[string]hub.RuleResult{}
	result := func() hub.RuleResult {
		if a.applyErr != nil {
			return hub.RuleResult{State: hub.RuleFailed, Code: "apply_failed"}
		}
		return hub.RuleResult{State: hub.RuleApplied}
	}
	if p.Browser.Managed {
		managed := result()
		if managed.State == hub.RuleApplied && (p.Extensions.Chrome == "" || p.Extensions.Edge == "") {
			managed = hub.RuleResult{State: hub.RuleFailed, Code: "extension_unpublished"}
		}
		rules["browser.managed"] = managed
		only := hub.RuleResult{State: hub.RuleApplied}
		if hasSession {
			names, err := a.d.Unmanaged(s.ID)
			switch {
			case err != nil:
				only = hub.RuleResult{State: hub.RuleFailed, Code: "detect_failed"}
			case len(names) > 0:
				only = hub.RuleResult{State: hub.RuleFailed, Code: "unmanaged_browser"}
			}
		}
		rules["browser.onlyManaged"] = only
	}
	if p.Browser.Incognito == "disabled" {
		rules["browser.incognito"] = result()
	}
	if p.Browser.DevTools == "disabled" {
		rules["browser.devTools"] = result()
	}
	for name, on := range map[string]bool{
		"os.standardUser":    p.OS.StandardUser,
		"os.blockAppInstall": p.OS.BlockAppInstall,
		"os.lockWallpaper":   p.OS.LockWallpaper,
	} {
		if on {
			rules[name] = hub.RuleResult{State: hub.RuleUnsupported}
		}
	}
	return rules
}

func (a *PolicyAgent) report(ctx context.Context, now time.Duration, s Session, hasSession bool) {
	r := hub.Receipt{Revision: a.current.Revision, Hash: a.current.Hash, Rules: a.rules(s, hasSession), Repaired: a.repaired}
	same := a.lastSent != nil && reflect.DeepEqual(a.lastSent.Rules, r.Rules) &&
		a.lastSent.Hash == r.Hash && a.lastSent.Revision == r.Revision
	if same && r.Repaired == nil && now < a.nextReport {
		return
	}
	if err := a.d.Report(ctx, r); err != nil {
		a.d.Log("siyosat receipt'i yuborilmadi: %v", err)
		return
	}
	a.lastSent = &r
	a.repaired = nil
	a.nextReport = now + PolicyReceiptRefresh
}
