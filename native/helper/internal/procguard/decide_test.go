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

// servicePID helper xizmati (session 0): Scanner o'z PID'ini ishonchli deb beradi.
const servicePID = uint32(400)

func allow() Allow { return DefaultAllow(`C:\Program Files`, `C:\Windows`, servicePID) }

// world baseline'dagi oddiy o'quvchi sessiyasi: winlogon → userinit (tugagan) → explorer → chrome → renderer.
func world() (map[uint32]Proc, map[uint32]bool) {
	procs := map[uint32]Proc{
		4:   {PID: 4, ParentPID: 0, Session: 0, Image: "", Created: at(0)},
		400: {PID: 400, ParentPID: 380, Session: 0, Image: pf + `\netschool\helper\netschool-helper.exe`, Created: at(3)},
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
	// sihost va RuntimeBroker (baseline'da bo'lsa ham) ochgan boshqa exe ham o'ldiriladi.
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

func TestSystemImagesAllowed(t *testing.T) {
	procs, baseline := world()
	allowed := []string{
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

const (
	companionExe = `C:\Program Files\NetSchool\companion\NetSchool Companion.exe`
	guardExe     = `C:\Program Files\NetSchool\helper\netschool-helper.exe`
	meshExe      = `C:\Program Files\Mesh Agent\MeshAgent.exe`
)

// NetSchool katalogidagi exe faqat helper xizmati ochgan bo'lsa (yoki uning NetSchool bolasi bo'lsa) yashaydi.
func TestNetSchoolImagesNeedHelperParent(t *testing.T) {
	procs, baseline := world()
	// Helper ochgan Companion va guard, Companion'ning Electron bolalari (bir xil exe).
	procs[1500] = Proc{PID: 1500, ParentPID: servicePID, Session: student, Image: companionExe, Created: at(50)}
	procs[1501] = Proc{PID: 1501, ParentPID: 1500, Session: student, Image: companionExe, Created: at(51)}
	procs[1502] = Proc{PID: 1502, ParentPID: servicePID, Session: student, Image: guardExe, Created: at(50)}
	for _, pid := range []uint32{1500, 1501, 1502} {
		if Decide(procs[pid], student, baseline, procs, allow()) {
			t.Fatalf("helper ochgan %d (%s) yashashi kerak", pid, procs[pid].Image)
		}
	}
	// Bloklash paytida yangi renderer ham.
	r := Proc{PID: 1503, ParentPID: 1500, Session: student, Image: companionExe, Created: at(100)}
	if decide(r, procs, baseline) {
		t.Fatal("Companion'ning yangi renderer'i yashashi kerak")
	}
	// O'quvchi o'zi (explorer, cmd yoki baseline'dan) ochgan Companion exe — o'ldiriladi (RunAsNode skript ishga
	// tushirgich bo'lib qolmasin).
	for i, parent := range []uint32{700, 800, 12345} {
		p := Proc{PID: uint32(1510 + i), ParentPID: parent, Session: student, Image: companionExe, Created: at(100)}
		if !decide(p, procs, baseline) {
			t.Fatalf("ota %d: o'quvchi ochgan Companion o'ldirilishi kerak", parent)
		}
	}
	// Bloklashdan oldin o'quvchi ochgan (baseline'dagi) Companion ham.
	procs[1520] = Proc{PID: 1520, ParentPID: 700, Session: student, Image: companionExe, Created: at(40)}
	baseline[1520] = true
	if !Decide(procs[1520], student, baseline, procs, allow()) {
		t.Fatal("baseline'dagi o'quvchi Companion'i o'ldirilishi kerak")
	}
	// Uning bolasi (bir xil exe, baseline ajdod) ham.
	c := Proc{PID: 1521, ParentPID: 1520, Session: student, Image: companionExe, Created: at(100)}
	if !decide(c, procs, baseline) {
		t.Fatal("o'quvchi Companion'ining bolasi o'ldirilishi kerak")
	}
	// Electron bolasini ota qilib (PARENT_PROCESS) ochilgan Companion: zanjir 3 bo'g'in — o'ldiriladi.
	spoof := Proc{PID: 1530, ParentPID: 1501, Session: student, Image: companionExe, Created: at(100)}
	if !decide(spoof, procs, baseline) {
		t.Fatal("Companion nevarasi (3-bo'g'in) o'ldirilishi kerak")
	}
	// Zanjirda NetSchool bo'lmagan exe: helper → cmd → Companion o'ldiriladi.
	procs[1540] = Proc{PID: 1540, ParentPID: servicePID, Session: student, Image: cmd, Created: at(60)}
	viaCmd := Proc{PID: 1541, ParentPID: 1540, Session: student, Image: companionExe, Created: at(100)}
	if !decide(viaCmd, procs, baseline) {
		t.Fatal("helper → cmd → Companion o'ldirilishi kerak")
	}
	// PID qayta ishlatilishi: "ota" boladan keyin yaratilgan — ishonilmaydi.
	late := Proc{PID: 1542, ParentPID: servicePID, Session: student, Image: companionExe, Created: at(1)}
	if !decide(late, procs, baseline) {
		t.Fatal("xizmatdan oldin yaratilgan Companion o'ldirilishi kerak")
	}
	// Ishonchli PID berilmagan bo'lsa NetSchool exe hech qachon yashamaydi.
	noTrust := DefaultAllow(`C:\Program Files`, `C:\Windows`)
	if !Decide(procs[1500], student, baseline, procs, noTrust) {
		t.Fatal("ishonchli PID'siz Companion o'ldirilishi kerak")
	}
}

// Mesh Agent exe faqat session 0'dagi Mesh Agent exe'si (MeshAgent xizmati) yoki shunday Mesh Agent zanjiri ochgan
// bo'lsa yashaydi.
func TestMeshAgentImagesNeedSessionZeroParent(t *testing.T) {
	procs, baseline := world()
	procs[300] = Proc{PID: 300, ParentPID: 4, Session: 0, Image: sysroot + `\system32\svchost.exe`, Created: at(2)}
	procs[350] = Proc{PID: 350, ParentPID: 300, Session: 0, Image: meshExe, Created: at(4)}
	kvm := Proc{PID: 1600, ParentPID: 350, Session: student, Image: meshExe, Created: at(100)}
	if decide(kvm, procs, baseline) {
		t.Fatal("MeshAgent KVM bolasi yashashi kerak")
	}
	sub := Proc{PID: 1601, ParentPID: 1600, Session: student, Image: meshExe, Created: at(101)}
	if decide(sub, procs, baseline) {
		t.Fatal("MeshAgent KVM bolasining Mesh bolasi yashashi kerak")
	}
	// O'quvchi ochgan MeshAgent.exe (explorer, baseline yoki noma'lum ota) — o'ldiriladi.
	for i, parent := range []uint32{700, 800, 12345} {
		p := Proc{PID: uint32(1610 + i), ParentPID: parent, Session: student, Image: meshExe, Created: at(100)}
		if !decide(p, procs, baseline) {
			t.Fatalf("ota %d: o'quvchi ochgan MeshAgent o'ldirilishi kerak", parent)
		}
	}
	// Session 0'dagi boshqa jarayon (svchost: Task Scheduler) ochgan Mesh exe — o'ldiriladi.
	viaSvc := Proc{PID: 1615, ParentPID: 300, Session: student, Image: meshExe, Created: at(100)}
	if !decide(viaSvc, procs, baseline) {
		t.Fatal("svchost ochgan MeshAgent o'ldirilishi kerak")
	}
	// O'quvchi ochgan Mesh'ning Mesh bolasi ham.
	procs[1620] = Proc{PID: 1620, ParentPID: 700, Session: student, Image: meshExe, Created: at(100)}
	child := Proc{PID: 1621, ParentPID: 1620, Session: student, Image: meshExe, Created: at(101)}
	if !decide(child, procs, baseline) {
		t.Fatal("o'quvchi MeshAgent'ining bolasi o'ldirilishi kerak")
	}
}

// Baseline'dan keyin ochilgan shell/UWP xostlari uchun istisno yo'q: session 0 ota (Task Scheduler, DcomLaunch)
// ularni oqlamaydi (o'quvchi vazifasi yoki HKCU COM surrogate'i ham shunday ochiladi).
func TestShellHostsAfterBaselineAreKilled(t *testing.T) {
	procs, baseline := world()
	procs[300] = Proc{PID: 300, ParentPID: 4, Session: 0, Image: sysroot + `\system32\svchost.exe`, Created: at(5)}
	procs[610] = Proc{PID: 610, ParentPID: 600, Session: student, Image: sysroot + `\system32\userinit.exe`, Created: at(100)}
	cases := []struct {
		image  string
		parent uint32
	}{
		{`\system32\dllhost.exe`, 300},
		{`\system32\taskhostw.exe`, 300},
		{`\system32\RuntimeBroker.exe`, 300},
		{`\system32\sihost.exe`, 300},
		{`\system32\userinit.exe`, 600},
		{`\explorer.exe`, 610},
		{`\explorer.exe`, 600},
		{`\system32\cmd.exe`, 300},
	}
	for i, c := range cases {
		p := Proc{PID: uint32(1700 + i), ParentPID: c.parent, Session: student, Image: sysroot + c.image, Created: at(101)}
		if !decide(p, procs, baseline) {
			t.Errorf("%s (ota %d) baseline'dan keyin o'ldirilishi kerak", c.image, c.parent)
		}
	}
}

// Kirish jarayonlari baseline'dan (kechiktirilgan, explorer paydo bo'lgach) OLDIN ochilgan: ular baseline'da va
// yashaydi.
func TestLogonProcessesBeforeDeferredBaselineSurvive(t *testing.T) {
	procs, _ := world()
	procs[300] = Proc{PID: 300, ParentPID: 4, Session: 0, Image: sysroot + `\system32\svchost.exe`, Created: at(5)}
	procs[610] = Proc{PID: 610, ParentPID: 600, Session: student, Image: sysroot + `\system32\userinit.exe`, Created: at(11)}
	procs[620] = Proc{PID: 620, ParentPID: 300, Session: student, Image: sysroot + `\system32\sihost.exe`, Created: at(12)}
	procs[630] = Proc{PID: 630, ParentPID: 300, Session: student, Image: sysroot + `\system32\taskhostw.exe`, Created: at(13)}
	procs[700] = Proc{PID: 700, ParentPID: 610, Session: student, Image: sysroot + `\explorer.exe`, Created: at(20)}
	b := NewBaseline(procs, student)
	live := b.Live(procs)
	for _, pid := range []uint32{600, 610, 620, 630, 700} {
		if Decide(procs[pid], student, live, procs, allow()) {
			t.Fatalf("baseline'dagi kirish jarayoni %s yashashi kerak", procs[pid].Image)
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
	p := Proc{PID: 970, ParentPID: 800, Session: student, Image: procs[800].Image, Created: at(25)}
	if !decide(p, procs, baseline) {
		t.Fatal("ota bolanikidan keyin yaratilgan: ota hisoblanmaydi, jarayon o'ldirilishi kerak")
	}
	// Vaqt noma'lum (nol) bo'lsa ham ishonilmaydi.
	q := Proc{PID: 971, ParentPID: 800, Session: student, Image: procs[800].Image}
	if !decide(q, procs, baseline) {
		t.Fatal("yaratilish vaqti noma'lum: ota-onaga ishonilmaydi")
	}
	procs[800] = Proc{PID: 800, ParentPID: 700, Session: student, Image: procs[800].Image}
	r := Proc{PID: 972, ParentPID: 800, Session: student, Image: procs[800].Image, Created: at(100)}
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
	a := DefaultAllow(`C:\Program Files\`, `\\?\C:\Windows`, 7)
	if a.NetSchoolDir != `c:\program files\netschool\` || a.MeshDir != `c:\program files\mesh agent\` {
		t.Fatalf("NetSchoolDir = %q, MeshDir = %q", a.NetSchoolDir, a.MeshDir)
	}
	if !a.Trusted[7] || len(a.Trusted) != 1 {
		t.Fatalf("Trusted = %v", a.Trusted)
	}
	if len(a.Images) != 10 {
		t.Fatalf("Images = %q", a.Images)
	}
	if len(a.Kill) != 1 || a.Kill[0] != `c:\windows\system32\taskmgr.exe` {
		t.Fatalf("Kill = %q", a.Kill)
	}
	for _, img := range a.Images {
		if img != Normalize(img) {
			t.Fatalf("%q normallashtirilmagan", img)
		}
	}
	// Bo'sh ildiz: ruxsat ro'yxati bo'sh, nisbiy yo'l hech narsaga mos kelmaydi.
	if e := DefaultAllow("", ""); e.NetSchoolDir != "" || e.MeshDir != "" || len(e.Images) != 0 || len(e.Kill) != 0 {
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
		procs[pid] = Proc{PID: pid, ParentPID: parent, Session: student, Image: pf + `\google\chrome\application\chrome.exe`, Created: at(100 + i)}
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

const (
	chrome = pf + `\google\chrome\application\chrome.exe`
	cmd    = sysroot + `\system32\cmd.exe`
)

func TestBaselineShellChildIsKilled(t *testing.T) {
	procs, baseline := world()
	// Bloklashdan oldin ochilgan cmd.exe dan bloklash paytida notepad ochildi.
	procs[1100] = Proc{PID: 1100, ParentPID: 700, Session: student, Image: cmd, Created: at(40)}
	baseline[1100] = true
	np := Proc{PID: 1101, ParentPID: 1100, Session: student, Image: sysroot + `\system32\notepad.exe`, Created: at(100)}
	if !decide(np, procs, baseline) {
		t.Fatal("baseline cmd'dan ochilgan notepad o'ldirilishi kerak")
	}
}

func TestSpoofedBaselineParentIsKilled(t *testing.T) {
	procs, baseline := world()
	// PROC_THREAD_ATTRIBUTE_PARENT_PROCESS bilan ota-ona sifatida baseline chrome ko'rsatilgan.
	evil := Proc{PID: 1110, ParentPID: 800, Session: student, Image: `c:\users\student\downloads\evil.exe`, Created: at(100)}
	if !decide(evil, procs, baseline) {
		t.Fatal("baseline chrome bolasi bo'lgan evil.exe o'ldirilishi kerak")
	}
}

func TestSameImageChain(t *testing.T) {
	procs, baseline := world()
	// chrome → chrome → chrome yashaydi.
	procs[1120] = Proc{PID: 1120, ParentPID: 800, Session: student, Image: chrome, Created: at(100)}
	c := Proc{PID: 1121, ParentPID: 1120, Session: student, Image: `C:\Program Files\Google\Chrome\Application\chrome.exe`, Created: at(101)}
	if decide(c, procs, baseline) {
		t.Fatal("chrome → chrome → chrome yashashi kerak")
	}
	// chrome → cmd → chrome o'ldiriladi.
	procs[1130] = Proc{PID: 1130, ParentPID: 800, Session: student, Image: cmd, Created: at(100)}
	d := Proc{PID: 1131, ParentPID: 1130, Session: student, Image: chrome, Created: at(101)}
	if !decide(d, procs, baseline) {
		t.Fatal("chrome → cmd → chrome o'ldirilishi kerak")
	}
	// explorer → WerFault (ruxsat etilgan, lekin ishonchli ajdod emas) → cmd o'ldiriladi.
	procs[1140] = Proc{PID: 1140, ParentPID: 700, Session: student, Image: sysroot + `\system32\werfault.exe`, Created: at(100)}
	if Decide(procs[1140], student, baseline, procs, allow()) {
		t.Fatal("WerFault o'zi ruxsat etilgan")
	}
	e := Proc{PID: 1141, ParentPID: 1140, Session: student, Image: cmd, Created: at(101)}
	if !decide(e, procs, baseline) {
		t.Fatal("explorer → WerFault → cmd o'ldirilishi kerak")
	}
	// Ruxsat etilgan jarayon (helper ochgan Companion) ham ishonchli ajdod emas.
	procs[1150] = Proc{PID: 1150, ParentPID: servicePID, Session: student, Image: pf + `\netschool\companion\companion.exe`, Created: at(100)}
	f := Proc{PID: 1151, ParentPID: 1150, Session: student, Image: pf + `\netschool\companion\companion.exe`, Created: at(101)}
	g := Proc{PID: 1152, ParentPID: 1151, Session: student, Image: pf + `\other\x.exe`, Created: at(102)}
	if decide(f, procs, baseline) || !decide(g, procs, baseline) {
		t.Fatal("Companion avlodi faqat ruxsat ro'yxati orqali yashaydi")
	}
}

func TestBaselineTaskManagerIsKilled(t *testing.T) {
	procs, baseline := world()
	tm := Proc{PID: 1200, ParentPID: 600, Session: student, Image: `C:\Windows\System32\Taskmgr.exe`, Created: at(40)}
	procs[1200] = tm
	baseline[1200] = true
	if !Decide(tm, student, baseline, procs, allow()) {
		t.Fatal("bloklashdan oldin ochilgan taskmgr ham o'ldirilishi kerak")
	}
	// Baseline explorer, sihost, RuntimeBroker o'zi yashaydi.
	procs[650] = Proc{PID: 650, ParentPID: 600, Session: student, Image: sysroot + `\system32\sihost.exe`, Created: at(15)}
	procs[660] = Proc{PID: 660, ParentPID: 600, Session: student, Image: sysroot + `\system32\runtimebroker.exe`, Created: at(16)}
	baseline[650], baseline[660] = true, true
	for _, pid := range []uint32{650, 660, 700} {
		if Decide(procs[pid], student, baseline, procs, allow()) {
			t.Fatalf("baseline %s yashashi kerak", procs[pid].Image)
		}
	}
}

func TestStaleParentRound(t *testing.T) {
	procs, baseline := world()
	// Toolhelp'dagi ota PID eskirgan (jarayon snapshot'dan keyin yaratilgan): bu safar tegilmaydi.
	p := Proc{PID: 1300, ParentPID: 700, Session: student, Image: `c:\users\student\evil.exe`, Created: at(100), Stale: true}
	if decide(p, procs, baseline) {
		t.Fatal("eskirgan jarayon bu safar o'ldirilmaydi")
	}
	// Ota sifatida ham ishonilmaydi.
	procs[1310] = Proc{PID: 1310, ParentPID: 800, Session: student, Image: chrome, Created: at(100), Stale: true}
	c := Proc{PID: 1311, ParentPID: 1310, Session: student, Image: chrome, Created: at(101)}
	if !decide(c, procs, baseline) {
		t.Fatal("eskirgan ota ishonchli emas")
	}
	// Baseline'ga kirmaydi.
	if _, ok := NewBaseline(procs, student)[1310]; ok {
		t.Fatal("eskirgan jarayon baseline'ga kirmasligi kerak")
	}
}

func TestStaleSkippedOneScanOnly(t *testing.T) {
	var tr staleTracker
	notepad := func(created time.Time) map[uint32]Proc {
		procs, _ := world()
		procs[1400] = Proc{PID: 1400, ParentPID: 700, Session: student, Image: sysroot + `\system32\notepad.exe`, Created: created, Stale: true}
		return procs
	}
	_, baseline := world()

	// 1-scan: Stale bir marta → o'tkazib yuboriladi.
	procs := notepad(at(100))
	tr.Round(procs)
	if !procs[1400].Stale || Decide(procs[1400], student, baseline, procs, allow()) {
		t.Fatal("birinchi Stale scan'da jarayon o'tkazib yuborilishi kerak")
	}
	// 2-scan: o'sha kalit yana Stale (soat orqaga ketgan) → oddiy qaror, o'ldiriladi.
	procs = notepad(at(100))
	tr.Round(procs)
	if procs[1400].Stale || !Decide(procs[1400], student, baseline, procs, allow()) {
		t.Fatal("ikkinchi marta Stale bo'lgan jarayon oddiy qaror bilan o'ldirilishi kerak")
	}
	// 2b-scan: hali ham Stale → yana baholanadi (istisno bir marta).
	procs = notepad(at(100))
	tr.Round(procs)
	if procs[1400].Stale {
		t.Fatal("istisno kalitga faqat bir marta beriladi")
	}
	// 3-scan: o'sha PID, boshqa Created → yangi kalit, yana bir marta o'tkaziladi.
	procs = notepad(at(200))
	tr.Round(procs)
	if !procs[1400].Stale {
		t.Fatal("boshqa Created bilan PID yangi kalit hisoblanadi")
	}
	// Eski kalitlar saqlanib qolmaydi (to'plam har scan'da almashtiriladi).
	if len(tr.prev) != 1 {
		t.Fatalf("prev = %v", tr.prev)
	}
	procs, _ = world()
	tr.Round(procs)
	if len(tr.prev) != 0 {
		t.Fatalf("Stale yo'q scan'dan keyin prev bo'sh bo'lishi kerak: %v", tr.prev)
	}
}
