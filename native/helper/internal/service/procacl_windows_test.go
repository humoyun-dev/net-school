//go:build windows

package service

import (
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestAllowInteractiveQueryAddsLimitedQueryOnly(t *testing.T) {
	if err := AllowInteractiveQuery(); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetSecurityInfo(windows.CurrentProcess(), windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	// SDDL: (A;;0x1000;;;IU) — faqat PROCESS_QUERY_LIMITED_INFORMATION.
	if s := sd.String(); !strings.Contains(s, "(A;;0x1000;;;IU)") {
		t.Fatalf("DACL = %s", s)
	}
}
