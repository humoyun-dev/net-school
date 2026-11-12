package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
)

// P2c: bazaviy siyosat (helperPolicySchema) va receipt (policyReceiptSchema, faqat `baseline` qatlami).
const (
	policyPath  = "/api/v1/device/helper/policy"
	receiptPath = "/api/v1/device/helper/policy/receipt"
)

// Revision tashkilot va site bazaviy versiyalari (0 — yo'q); ikkalasi monoton.
type Revision struct {
	Org  int `json:"org"`
	Site int `json:"site"`
}

// BrowserRules — `browser` bo'limi (effective, standartlar bilan to'ldirilgan).
type BrowserRules struct {
	Managed   bool   `json:"managed"`
	Incognito string `json:"incognito"`
	DevTools  string `json:"devTools"`
}

// OSRules — `os` bo'limi (P2h qo'llaydi; P2c'da `unsupported`).
type OSRules struct {
	StandardUser    bool `json:"standardUser"`
	BlockAppInstall bool `json:"blockAppInstall"`
	LockWallpaper   bool `json:"lockWallpaper"`
}

// ExtensionIDs do'kon ID'lari; bo'sh satr — hali chiqarilmagan.
type ExtensionIDs struct {
	Chrome string
	Edge   string
}

// BaselinePolicy Helper'ga kerakli qism; `web` bo'limini Companion/extension qo'llaydi.
type BaselinePolicy struct {
	Revision   Revision
	Hash       string
	Browser    BrowserRules
	OS         OSRules
	Extensions ExtensionIDs
}

// Rule natijalari.
const (
	RuleApplied     = "applied"
	RuleFailed      = "failed"
	RuleUnsupported = "unsupported"
)

type RuleResult struct {
	State string `json:"state"`
	Code  string `json:"code,omitempty"`
}

// Receipt bazaviy qatlam natijasi. Repaired — shu tekshiruvda drift topilib qayta qo'llangan qoidalar.
type Receipt struct {
	Revision Revision
	Hash     string
	Rules    map[string]RuleResult
	Repaired []string
}

var (
	extensionID = regexp.MustCompile(`^[a-p]{32}$`)
	contentHash = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type wirePolicy struct {
	Baseline struct {
		Revision Revision `json:"revision"`
		Hash     string   `json:"hash"`
		Document struct {
			Browser BrowserRules `json:"browser"`
			OS      OSRules      `json:"os"`
		} `json:"document"`
	} `json:"baseline"`
	Extensions struct {
		Chrome *string `json:"chrome"`
		Edge   *string `json:"edge"`
	} `json:"extensions"`
}

// ParseBaselinePolicy hub javobini (yoki keshdagi nusxasini) o'qiydi va tekshiradi: ID va hash formati, revision
// manfiy emas. Extension ID registr kalitiga yoziladi, shuning uchun qat'iy formatda bo'lishi shart.
func ParseBaselinePolicy(raw []byte) (BaselinePolicy, error) {
	var w wirePolicy
	if err := json.Unmarshal(raw, &w); err != nil {
		return BaselinePolicy{}, fmt.Errorf("siyosat javobi o'qilmadi: %w", err)
	}
	b := w.Baseline
	if b.Revision.Org < 0 || b.Revision.Site < 0 || !contentHash.MatchString(b.Hash) {
		return BaselinePolicy{}, errors.New("siyosat javobida revision yoki hash yaroqsiz")
	}
	if !allowedDisabled(b.Document.Browser.Incognito) || !allowedDisabled(b.Document.Browser.DevTools) {
		return BaselinePolicy{}, errors.New("siyosat javobida browser qiymati yaroqsiz")
	}
	ids := ExtensionIDs{}
	for _, item := range []struct {
		in  *string
		out *string
	}{{w.Extensions.Chrome, &ids.Chrome}, {w.Extensions.Edge, &ids.Edge}} {
		if item.in == nil {
			continue
		}
		if !extensionID.MatchString(*item.in) {
			return BaselinePolicy{}, errors.New("siyosat javobida extension ID yaroqsiz")
		}
		*item.out = *item.in
	}
	return BaselinePolicy{
		Revision:   b.Revision,
		Hash:       b.Hash,
		Browser:    b.Document.Browser,
		OS:         b.Document.OS,
		Extensions: ids,
	}, nil
}

func allowedDisabled(v string) bool { return v == "allowed" || v == "disabled" }

// BaselinePolicyRaw javobning xom baytlari (keshga yozish uchun) va o'qilgan ko'rinishi.
func (c *Client) BaselinePolicyRaw(ctx context.Context) (BaselinePolicy, []byte, error) {
	res, err := c.do(ctx, http.MethodGet, policyPath, nil)
	if err != nil {
		return BaselinePolicy{}, nil, err
	}
	p, err := ParseBaselinePolicy(res.body)
	return p, res.body, err
}

// BaselinePolicy hub'dan joriy bazaviy siyosatni oladi.
func (c *Client) BaselinePolicy(ctx context.Context) (BaselinePolicy, error) {
	p, _, err := c.BaselinePolicyRaw(ctx)
	return p, err
}

// ReportPolicyReceipt bazaviy qatlam natijasini yuboradi (204).
func (c *Client) ReportPolicyReceipt(ctx context.Context, r Receipt) error {
	payload := struct {
		Layer    string                `json:"layer"`
		Revision Revision              `json:"revision"`
		Hash     string                `json:"hash"`
		Rules    map[string]RuleResult `json:"rules"`
		Repaired []string              `json:"repaired,omitempty"`
	}{"baseline", r.Revision, r.Hash, r.Rules, r.Repaired}
	if payload.Rules == nil {
		payload.Rules = map[string]RuleResult{}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = c.do(ctx, http.MethodPut, receiptPath, body)
	return err
}
