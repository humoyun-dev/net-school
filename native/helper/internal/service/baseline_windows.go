//go:build windows

package service

import (
	"context"
	"errors"
	"os"

	"github.com/humoyun-dev/net-school/native/helper/internal/browser"
	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

// newBaselineAgent P2c bazaviy siyosat agentini Windows portlari bilan yig'adi: hub (helper kaliti), helper
// katalogidagi kesh (Step faqat katalog tekshirilgach chaqiriladi), HKLM brauzer siyosatlari va host manifest'i.
func newBaselineAgent(p paths, h PolicyHub, warn func(string, ...any)) *PolicyAgent {
	reg := browser.NewRegistry()
	return NewPolicyAgent(PolicyDeps{
		Fetch: func(ctx context.Context) ([]byte, error) {
			_, raw, err := h.BaselinePolicyRaw(ctx)
			return raw, err
		},
		Report: h.ReportPolicyReceipt,
		LoadCache: func() ([]byte, error) {
			raw, err := os.ReadFile(p.baselineCache)
			if errors.Is(err, os.ErrNotExist) {
				return nil, nil
			}
			return raw, err
		},
		SaveCache: func(raw []byte) error {
			tmp := p.baselineCache + ".new"
			if err := os.WriteFile(tmp, raw, 0o600); err != nil {
				return err
			}
			return os.Rename(tmp, p.baselineCache)
		},
		Apply: func(pol hub.BaselinePolicy) ([]string, error) {
			manifest := ""
			if pol.Browser.Managed {
				path, err := browser.WriteHostManifest(p.browserDir, browser.HostManifest(p.helperExe, pol.Extensions))
				if err != nil {
					return nil, err
				}
				manifest = path
			}
			return browser.Apply(reg, browser.Plan(pol, manifest))
		},
		Unmanaged: browser.UnmanagedRunning,
		Log:       warn,
	})
}
