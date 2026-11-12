package nativehost

import (
	"testing"

	"github.com/humoyun-dev/net-school/native/helper/internal/procguard"
)

const companion = `C:\Program Files\NetSchool\companion\NetSchool Companion.exe`

func procs() map[uint32]procguard.Proc {
	return map[uint32]procguard.Proc{
		100: {PID: 100, ParentPID: 4, Image: `c:\program files\netschool\helper\netschool-helper.exe`},
		200: {PID: 200, ParentPID: 100, Session: 1, Image: procguard.Normalize(companion)},
		// O'quvchi Companion.exe'ni RunAsNode bilan o'zi ishga tushirgan (ota — explorer).
		300: {PID: 300, ParentPID: 400, Session: 1, Image: procguard.Normalize(companion)},
		400: {PID: 400, ParentPID: 1, Session: 1, Image: `c:\windows\explorer.exe`},
		500: {PID: 500, ParentPID: 100, Session: 1, Image: `c:\users\s\evil.exe`},
	}
}

func TestServerTrustedOnlyForHelperLaunchedCompanion(t *testing.T) {
	if err := ServerTrusted(procs(), 200, 100, companion); err != nil {
		t.Fatalf("haqiqiy Companion rad etildi: %v", err)
	}
	for name, c := range map[string]struct{ server, service uint32 }{
		"RunAsNode Companion (ota explorer)": {300, 100},
		"begona image":                       {500, 100},
		"xizmat to'xtagan (PID 0)":           {200, 0},
		"server jarayoni yo'q":               {999, 100},
	} {
		if err := ServerTrusted(procs(), c.server, c.service, companion); err == nil {
			t.Fatalf("%s qabul qilindi", name)
		}
	}
}

func TestStaleServerIsRejected(t *testing.T) {
	p := procs()
	s := p[200]
	s.Stale = true
	p[200] = s
	if err := ServerTrusted(p, 200, 100, companion); err == nil {
		t.Fatal("stale ParentPID'ga ishonildi")
	}
}
