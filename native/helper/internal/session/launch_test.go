package session

import "testing"

// TestZeroLaunchOptionsAreProtected nol qiymat eng xavfsiz holat: himoyalangan SD va tozalangan muhit.
func TestZeroLaunchOptionsAreProtected(t *testing.T) {
	const sid = "S-1-5-21-1-2-3-1001"
	var o LaunchOptions
	if !o.SanitizedEnv() {
		t.Fatal("nol LaunchOptions muhitni tozalamaydi")
	}
	proc, thread, err := o.descriptors(sid)
	if err != nil {
		t.Fatal(err)
	}
	wantProc, _ := ProcessSDDL(sid)
	wantThread, _ := ThreadSDDL(sid)
	if proc != wantProc || thread != wantThread {
		t.Fatalf("descriptors = %q, %q; kutilgan %q, %q", proc, thread, wantProc, wantThread)
	}
	if CompanionLaunch != (LaunchOptions{}) {
		t.Fatalf("CompanionLaunch = %+v, nol qiymat (himoyalangan) kutilgan", CompanionLaunch)
	}
}

// TestShellLaunchUsesDefaults explorer standart SD (bo'sh SDDL — nil lpProcessAttributes) va to'liq muhit bilan.
func TestShellLaunchUsesDefaults(t *testing.T) {
	if ShellLaunch.SanitizedEnv() {
		t.Fatal("ShellLaunch muhitni tozalaydi")
	}
	proc, thread, err := ShellLaunch.descriptors("S-1-5-21-1-2-3-1001")
	if err != nil {
		t.Fatal(err)
	}
	if proc != "" || thread != "" {
		t.Fatalf("ShellLaunch descriptors = %q, %q; bo'sh kutilgan", proc, thread)
	}
	// Himoyasiz rejimda SID tekshirilmaydi: SDDL umuman yasalmaydi.
	if _, _, err := ShellLaunch.descriptors("bad"); err != nil {
		t.Fatalf("ShellLaunch yaroqsiz SID'da xato: %v", err)
	}
}

func TestProtectedLaunchRejectsBadSID(t *testing.T) {
	if _, _, err := CompanionLaunch.descriptors("bad"); err == nil {
		t.Fatal("yaroqsiz SID qabul qilindi")
	}
}
