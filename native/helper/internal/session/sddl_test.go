package session

import (
	"strings"
	"testing"
)

func TestProcessSDDLForUser(t *testing.T) {
	const sid = "S-1-5-21-1-2-3-1001"
	got, err := ProcessSDDL(sid)
	if err != nil {
		t.Fatal(err)
	}
	want := "D:P(A;;0x1fffff;;;SY)(A;;0x1fffff;;;BA)(A;;0x121000;;;OW)(A;;0x121000;;;" + sid + ")"
	if got != want {
		t.Fatalf("ProcessSDDL = %q, kutilgan %q", got, want)
	}
	// Foydalanuvchi va OWNER RIGHTS'da to'xtatish, xotira, ip, dastak, DACL/egasi huquqlari yo'q.
	const forbidden = 0x0001 | 0x0002 | 0x0008 | 0x0010 | 0x0020 | 0x0040 | 0x0080 | 0x0200 | 0x0800 | 0x40000 | 0x80000
	if userProcessAccess&forbidden != 0 {
		t.Fatalf("foydalanuvchi huquqlari %#x taqiqlanganlarni o'z ichiga oladi", userProcessAccess)
	}
	thr, err := ThreadSDDL(sid)
	if err != nil {
		t.Fatal(err)
	}
	if thr != "D:P(A;;0x1fffff;;;SY)(A;;0x1fffff;;;BA)(A;;0x120800;;;OW)(A;;0x120800;;;"+sid+")" {
		t.Fatalf("ThreadSDDL = %q", thr)
	}
	// THREAD_TERMINATE, SUSPEND_RESUME, GET/SET_CONTEXT, SET_INFORMATION, IMPERSONATE, WRITE_DAC/OWNER yo'q.
	const threadForbidden = 0x0001 | 0x0002 | 0x0008 | 0x0010 | 0x0020 | 0x0100 | 0x0200 | 0x40000 | 0x80000
	if userThreadAccess&threadForbidden != 0 {
		t.Fatalf("ip huquqlari %#x taqiqlanganlarni o'z ichiga oladi", userThreadAccess)
	}
}

func TestSDDLWithoutUser(t *testing.T) {
	// Guard (SYSTEM): foydalanuvchi ACE'si yo'q.
	got, err := ProcessSDDL("")
	if err != nil {
		t.Fatal(err)
	}
	if got != "D:P(A;;0x1fffff;;;SY)(A;;0x1fffff;;;BA)(A;;0x121000;;;OW)" {
		t.Fatalf("ProcessSDDL(\"\") = %q", got)
	}
}

func TestSDDLRejectsInjectedSID(t *testing.T) {
	for _, bad := range []string{"S-1-5-21-1)(A;;GA;;;WD", "WD", "S-1-5-21-1;x", "s-1-5-21-1"} {
		if _, err := ProcessSDDL(bad); err == nil || !strings.Contains(err.Error(), "SID") {
			t.Fatalf("%q qabul qilindi: %v", bad, err)
		}
	}
}
