//go:build windows

package service

import (
	"golang.org/x/sys/windows"
)

// AllowInteractiveQuery xizmat jarayoni DACL'iga Interactive (S-1-5-4) uchun faqat
// PROCESS_QUERY_LIMITED_INFORMATION qo'shadi: o'quvchi nomidan ishlaydigan native messaging host xizmatning
// yaratilish vaqtini o'qiy olsin (PID qayta berilishiga qarshi tekshiruv, nativehost.ServerTrusted). O'qish yoki
// boshqarish huquqi berilmaydi.
func AllowInteractiveQuery() error {
	self := windows.CurrentProcess()
	sd, err := windows.GetSecurityInfo(self, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	old, _, err := sd.DACL()
	if err != nil {
		return err
	}
	interactive, err := windows.CreateWellKnownSid(windows.WinInteractiveSid)
	if err != nil {
		return err
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.PROCESS_QUERY_LIMITED_INFORMATION,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       windows.NO_INHERITANCE,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_WELL_KNOWN_GROUP,
			TrusteeValue: windows.TrusteeValueFromSID(interactive),
		},
	}}, old)
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(self, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}
