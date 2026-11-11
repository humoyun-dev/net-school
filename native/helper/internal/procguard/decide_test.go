package procguard

import (
	"testing"
	"time"
)

const (
	student = uint32(2)
	pf      = `c:\program files`
	sysroot = `c:\windows`
)

var t0 = time.Date(2026, 11, 9, 9, 0, 0, 0, time.UTC)

func at(sec int) time.Time { return t0.Add(time.Duration(sec) * time.Second) }

func allow() Allow { return DefaultAllow(`C:\Program Files`, `C:\Windows`) }

// world baseline'dagi oddiy o'quvchi sessiyasi: winlogon → userinit (tugagan) → explorer → chrome → renderer.
func world() (map[uint32]Proc, map[uint32]bool) {
	procs := map[uint32]Proc{
		4:   {PID: 4, ParentPID: 0, Session: 0, Image: "", Created: at(0)},
		600: {PID: 600, ParentPID: 500, Session: student, Image: sysroot + `\system32\winlogon.exe`, Created: at(10)},
		700: {PID: 700, ParentPID: 650, Session: student, Image: sysroot + `\explorer.exe`, Created: at(20)},
		800: {PID: 800, ParentPID: 700, Session: student, Image: pf + `\google\chrome\application\chrome.exe`, Created: at(30)},
		801: {PID: 801, ParentPID: 800, Session: student, Image: pf + `\google\chrome\application\chrome.exe`, Created: at(31)},
	}
	baseline := map[uint32]bool{600: true, 700: true, 800: true, 801: true}
	return procs, baseline
}

func decide(p Proc, procs map[uint32]Proc, baseline map[uint32]bool) bool {
	procs[p.PID] = p
	return Decide(p, student, baseline, procs, allow())
}

func TestBaselineDescendantsSurvive(t *testing.T) {
	procs, baseline := world()
	// Bloklashdan oldin ochilgan dasturlar o'zi yashaydi.
	for _, pid := range []uint32{600, 700, 800, 801} {
		if Decide(procs[pid], student, baseline, procs, allow()) {
			t.Fatalf("baseline jarayon %d o'ldirilmasligi kerak", pid)
		}
	}
	// Bloklash paytida brauzer yangi tab (renderer) ochadi — u baseline chrome avlodi.
	tab := Proc{PID: 900, ParentPID: 800, Session: student, Image: pf + `\google\chrome\application\chrome.exe`, Created: at(100)}
	if decide(tab, procs, baseline) {
		t.Fatal("baseline chrome'ning yangi tabi o'ldirilmasligi kerak")
	}
	// Nevara ham (yangi oraliq jarayon orqali) yashaydi.
	grandchild := Proc{PID: 901, ParentPID: 900, Session: student, Image: pf + `\google\chrome\application\chrome.exe`, Created: at(101)}
	if decide(grandchild, procs, baseline) {
		t.Fatal("baseline chrome'ning nevarasi o'ldirilmasligi kerak")
	}
}

func TestTaskManagerIsKilled(t *testing.T) {
	procs, baseline := world()
	// Ctrl+Shift+Esc: taskmgr sessiyadagi winlogon (baseline) bolasi.
	tm := Proc{PID: 910, ParentPID: 600, Session: student, Image: sysroot + `\system32\taskmgr.exe`, Created: at(100)}
	if !decide(tm, procs, baseline) {
		t.Fatal("yangi taskmgr o'ldirilishi kerak")
	}
	// Baseline dastur (chrome) ichidan ochilgan taskmgr ham.
	tm2 := Proc{PID: 911, ParentPID: 800, Session: student, Image: sysroot + `\system32\taskmgr.exe`, Created: at(100)}
	if !decide(tm2, procs, baseline) {
		t.Fatal("chrome bolasi bo'lgan taskmgr ham o'ldirilishi kerak")
	}
	// Katta-kichik harf farqi qochish yo'li emas.
	tm3 := Proc{PID: 912, ParentPID: 600, Session: student, Image: `C:\Windows\System32\TaskMgr.EXE`, Created: at(100)}
	if !decide(tm3, procs, baseline) {
		t.Fatal("TaskMgr.EXE ham o'ldirilishi kerak")
	}
	// taskmgr'dan ochilgan dastur ("Yangi vazifa").
	child := Proc{PID: 913, ParentPID: 910, Session: student, Image: sysroot + `\system32\cmd.exe`, Created: at(101)}
	if !decide(child, procs, baseline) {
		t.Fatal("taskmgr bolasi o'ldirilishi kerak")
	}
}

func TestChildOfExplorerIsKilled(t *testing.T) {
	procs, baseline := world()
	// Baseline explorer o'zi yashaydi, lekin undan ochilgan yangi dastur o'ldiriladi.
	notepad := Proc{PID: 920, ParentPID: 700, Session: student, Image: sysroot + `\system32\notepad.exe`, Created: at(100)}
	if !decide(notepad, procs, baseline) {
		t.Fatal("explorer'dan ochilgan notepad o'ldirilishi kerak")
	}
	// Uning bolasi ham (zanjirda explorer bor).
	child := Proc{PID: 921, ParentPID: 920, Session: student, Image: sysroot + `\system32\cmd.exe`, Created: at(101)}
	if !decide(child, procs, baseline) {
		t.Fatal("explorer avlodi o'ldirilishi kerak")
	}
	// sihost va RuntimeBroker ham ishga tushiruvchi hisoblanadi, baseline'da bo'lsa ham.
	procs[650] = Proc{PID: 650, ParentPID: 600, Session: student, Image: sysroot + `\system32\sihost.exe`, Created: at(15)}
	procs[660] = Proc{PID: 660, ParentPID: 600, Session: student, Image: sysroot + `\system32\runtimebroker.exe`, Created: at(16)}
	baseline[650], baseline[660] = true, true
	for _, parent := range []uint32{650, 660} {
		p := Proc{PID: 930 + parent, ParentPID: parent, Session: student, Image: pf + `\app\app.exe`, Created: at(100)}
		if !decide(p, procs, baseline) {
			t.Fatalf("%s bolasi o'ldirilishi kerak", procs[parent].Image)
		}
	}
	// Yangi explorer (masalan, o'quvchi uni qayta ishga tushirgan) o'zi ham o'ldiriladi.
	ex := Proc{PID: 940, ParentPID: 600, Session: student, Image: sysroot + `\explorer.exe`, Created: at(100)}
	if !decide(ex, procs, baseline) {
		t.Fatal("yangi explorer o'ldirilishi kerak")
	}
	// Yangi ildizdan (ota-onasi yo'q) boshlangan jarayon o'ldiriladi.
	orphan := Proc{PID: 950, ParentPID: 12345, Session: student, Image: pf + `\app\app.exe`, Created: at(100)}
	if !decide(orphan, procs, baseline) {
		t.Fatal("ota-onasi yo'q yangi jarayon o'ldirilishi kerak")
	}
	// Boshqa sessiyadagi (xizmat) ota-onadan o'quvchi sessiyasiga ochilgan jarayon ham.
	procs[300] = Proc{PID: 300, ParentPID: 4, Session: 0, Image: sysroot + `\system32\svchost.exe`, Created: at(5)}
	svcChild := Proc{PID: 951, ParentPID: 300, Session: student, Image: pf + `\app\app.exe`, Created: at(100)}
	if !decide(svcChild, procs, baseline) {
		t.Fatal("xizmat ochgan baseline'siz jarayon o'ldirilishi kerak")
	}
}

func TestNetSchoolAndMeshAgentAllowed(t *testing.T) {
	procs, baseline := world()
	allowed := []string{
		`C:\Program Files\NetSchool\helper\netschool-helper.exe`,
		`C:\Program Files\NetSchool\companion\NetSchool Companion.exe`,
		`C:\Program Files\Mesh Agent\MeshAgent.exe`,
		`\\?\C:\Program Files\NetSchool\companion\NetSchool Companion.exe`,
		sysroot + `\system32\conhost.exe`,
		sysroot + `\system32\dwm.exe`,
		sysroot + `\system32\csrss.exe`,
		sysroot + `\system32\fontdrvhost.exe`,
		sysroot + `\system32\ctfmon.exe`,
		sysroot + `\system32\logonui.exe`,
		sysroot + `\system32\consent.exe`,
		sysroot + `\system32\werfault.exe`,
		sysroot + `\system32\systemsettingsbroker.exe`,
		sysroot + `\systemapps\microsoftwindows.client.cbs_cw5n1h2txyewy\textinputhost.exe`,
	}
	for i, img := range allowed {
		// Explorer'dan ochilgan bo'lsa ham ruxsat etilgan.
		p := Proc{PID: uint32(1000 + i), ParentPID: 700, Session: student, Image: img, Created: at(100)}
		if decide(p, procs, baseline) {
			t.Errorf("%s ruxsat etilgan bo'lishi kerak", img)
		}
	}
	denied := []string{
		// Katalog chegarasi: NetSchoolEvil NetSchool emas.
		`C:\Program Files\NetSchoolEvil\x.exe`,
		`C:\Program Files\Mesh AgentX\MeshAgent.exe`,
		// Ruxsat etilgan nom boshqa joyda — ruxsat emas.
		`C:\Users\student\Downloads\conhost.exe`,
		sysroot + `\system32\conhost.exe.evil.exe`,
		sysroot + `\syswow64\dwm.exe`,
		`C:\NetSchool\helper\netschool-helper.exe`,
	}
	for i, img := range denied {
		p := Proc{PID: uint32(2000 + i), ParentPID: 700, Session: student, Image: img, Created: at(100)}
		if !decide(p, procs, baseline) {
			t.Errorf("%s o'ldirilishi kerak", img)
		}
	}
}

func TestOtherSessionIgnored(t *testing.T) {
	procs, baseline := world()
	for _, s := range []uint32{0, 1, 3} {
		p := Proc{PID: 960 + s, ParentPID: 700, Session: s, Image: sysroot + `\system32\taskmgr.exe`, Created: at(100)}
		if decide(p, procs, baseline) {
			t.Fatalf("sessiya %d dagi jarayon o'ldirilmasligi kerak", s)
		}
	}
}

func TestPidReuseNotTrusted(t *testing.T) {
	procs, baseline := world()
	// Bolaning haqiqiy otasi (PID 800) tugagan va PID baseline chrome'ga qayta berilgan: baseline PID 800 jarayoni
	// bolanikidan keyin yaratilgan, demak u bolaning otasi emas.
	p := Proc{PID: 970, ParentPID: 800, Session: student, Image: pf + `\app\app.exe`, Created: at(25)}
	if !decide(p, procs, baseline) {
		t.Fatal("ota bolanikidan keyin yaratilgan: ota hisoblanmaydi, jarayon o'ldirilishi kerak")
	}
	// Vaqt noma'lum (nol) bo'lsa ham ishonilmaydi.
	q := Proc{PID: 971, ParentPID: 800, Session: student, Image: pf + `\app\app.exe`}
	if !decide(q, procs, baseline) {
		t.Fatal("yaratilish vaqti noma'lum: ota-onaga ishonilmaydi")
	}
	procs[800] = Proc{PID: 800, ParentPID: 700, Session: student, Image: procs[800].Image}
	r := Proc{PID: 972, ParentPID: 800, Session: student, Image: pf + `\app\app.exe`, Created: at(100)}
	if !decide(r, procs, baseline) {
		t.Fatal("otaning yaratilish vaqti noma'lum: unga ishonilmaydi")
	}
}

func TestCycleTerminates(t *testing.T) {
	procs, baseline := world()
	// Bir xil vaqtli tsikl (soxta yoki buzilgan snapshot): sikl abadiy aylanmaydi va jarayon o'ldiriladi.
	procs[980] = Proc{PID: 980, ParentPID: 981, Session: student, Image: pf + `\a.exe`, Created: at(100)}
	procs[981] = Proc{PID: 981, ParentPID: 980, Session: student, Image: pf + `\b.exe`, Created: at(100)}
	if !Decide(procs[980], student, baseline, procs, allow()) {
		t.Fatal("tsikldagi yangi jarayon o'ldirilishi kerak")
	}
	self := Proc{PID: 982, ParentPID: 982, Session: student, Image: pf + `\c.exe`, Created: at(100)}
	if !decide(self, procs, baseline) {
		t.Fatal("o'ziga ota bo'lgan yangi jarayon o'ldirilishi kerak")
	}
}

func TestUnknownImage(t *testing.T) {
	procs, baseline := world()
	// Yo'li o'qilmagan (himoyalangan) jarayon: baseline'da bo'lmasa avlod qoidasi qo'llanmaydi.
	p := Proc{PID: 990, ParentPID: 800, Session: student, Created: at(100)}
	if !decide(p, procs, baseline) {
		t.Fatal("yo'li noma'lum yangi jarayon o'ldirilishi kerak")
	}
	// Baseline'dagisi yashaydi.
	procs[600] = Proc{PID: 600, ParentPID: 500, Session: student, Created: at(10)}
	if Decide(procs[600], student, baseline, procs, allow()) {
		t.Fatal("yo'li noma'lum baseline jarayon yashashi kerak")
	}
}

func TestSystemPidsNeverKilled(t *testing.T) {
	procs, baseline := world()
	for _, pid := range []uint32{0, 4} {
		p := Proc{PID: pid, Session: student, Image: pf + `\x.exe`, Created: at(100)}
		if decide(p, procs, baseline) {
			t.Fatalf("PID %d hech qachon o'ldirilmaydi", pid)
		}
	}
}

func TestDefaultAllow(t *testing.T) {
	a := DefaultAllow(`C:\Program Files\`, `\\?\C:\Windows`)
	want := map[string]bool{`c:\program files\netschool\`: true, `c:\program files\mesh agent\`: true}
	if len(a.Dirs) != len(want) {
		t.Fatalf("Dirs = %q", a.Dirs)
	}
	for _, d := range a.Dirs {
		if !want[d] {
			t.Fatalf("kutilmagan katalog %q", d)
		}
	}
	if len(a.Images) != 10 {
		t.Fatalf("Images = %q", a.Images)
	}
	for _, img := range a.Images {
		if img != Normalize(img) {
			t.Fatalf("%q normallashtirilmagan", img)
		}
	}
	// Bo'sh ildiz: ruxsat ro'yxati bo'sh, nisbiy yo'l hech narsaga mos kelmaydi.
	if e := DefaultAllow("", ""); len(e.Dirs) != 0 || len(e.Images) != 0 {
		t.Fatalf("bo'sh ildiz bilan ruxsat ro'yxati bo'sh bo'lishi kerak: %+v", e)
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		`C:\Windows\System32\X.exe`:    `c:\windows\system32\x.exe`,
		`\\?\C:\Windows\X.exe`:         `c:\windows\x.exe`,
		`\\?\UNC\server\share\x.exe`:   `\\server\share\x.exe`,
		`C:/Program Files/NetSchool/a`: `c:\program files\netschool\a`,
		"":                             "",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, kutilgan %q", in, got, want)
		}
	}
}

func TestLongChainKilled(t *testing.T) {
	procs, baseline := world()
	// maxDepth'dan uzun yangi zanjir (baseline'gacha yetmaydi) → o'ldiriladi.
	parent := uint32(800)
	for i := range maxDepth + 5 {
		pid := uint32(3000 + i)
		procs[pid] = Proc{PID: pid, ParentPID: parent, Session: student, Image: pf + `\app\app.exe`, Created: at(100 + i)}
		parent = pid
	}
	if !Decide(procs[parent], student, baseline, procs, allow()) {
		t.Fatal("juda uzun zanjir o'ldirilishi kerak")
	}
	// Qisqasi esa baseline chrome'gacha yetadi.
	if Decide(procs[3005], student, baseline, procs, allow()) {
		t.Fatal("qisqa zanjir baseline chrome avlodi")
	}
}

func TestBaselineSurvivesOnlySameProcess(t *testing.T) {
	procs, _ := world()
	procs[300] = Proc{PID: 300, ParentPID: 4, Session: 0, Image: `c:\windows\system32\svchost.exe`, Created: at(5)}
	b := NewBaseline(procs, student)
	if _, ok := b[300]; len(b) != 4 || ok {
		t.Fatalf("baseline faqat o'quvchi sessiyasidan: %v", b)
	}
	live := b.Live(procs)
	for _, pid := range []uint32{600, 700, 800, 801} {
		if !live[pid] {
			t.Fatalf("%d tirik baseline bo'lishi kerak", pid)
		}
	}
	// 801 tugadi, 800 tugab PID boshqa jarayonga berildi.
	delete(procs, 801)
	procs[800] = Proc{PID: 800, ParentPID: 700, Session: student, Image: pf + `\evil\evil.exe`, Created: at(200)}
	live = b.Live(procs)
	if live[800] || live[801] || !live[700] {
		t.Fatalf("qayta ishlatilgan/tugagan PID baseline emas: %v", live)
	}
	evil := procs[800]
	if !Decide(evil, student, live, procs, allow()) {
		t.Fatal("baseline PID'ini qayta olgan yangi jarayon o'ldirilishi kerak")
	}
}
