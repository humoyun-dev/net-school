// Package procguard bloklash paytida o'quvchi sessiyasida yangi ochilgan dasturlarni to'xtatadi (process guard).
//
// Qaror toza mantiq (Decide), har OS'da test qilinadi; snapshot va TerminateProcess scan_windows.go'da.
//
// Qoida (ADR 0014):
//   - boshqa sessiyadagi jarayon, PID 0 va 4 → tegilmaydi; Toolhelp'dagi ota PID'i eskirgan (Stale) jarayon → bu
//     safar tegilmaydi, keyingi snapshot'da qayta ko'riladi;
//   - %ProgramFiles%\NetSchool\ ichidagi exe → faqat ota zanjiri (faqat NetSchool exe'lari orqali, ko'pi bilan 2
//     bo'g'in) helper xizmatiga (Allow.Trusted) yetsa yashaydi, aks holda baseline'da bo'lsa ham o'ldiriladi: o'quvchi
//     o'zi ochgan Companion exe'si (RunAsNode bilan skript ishga tushirgich) yashamasin;
//   - %ProgramFiles%\Mesh Agent\ ichidagi exe → faqat ota zanjiri (Mesh Agent exe'lari orqali) session 0 jarayoniga
//     (MeshAgent xizmati) yetsa yashaydi;
//   - Allow.Images'dagi (to'liq yo'l bilan) tizim jarayoni → tegilmaydi. Ruxsat etilgan jarayon boshqalar uchun
//     ishonchli ajdod emas;
//   - Allow.Kill'dagi jarayon (%SystemRoot%\System32\taskmgr.exe) → baseline'da bo'lsa ham o'ldiriladi: bloklashdan
//     oldin ochilgan Task Manager bilan Companion'ni yoki boshqa jarayonni to'xtatish mumkin edi;
//   - kirish (logon) shell jarayonlari: System32 userinit, sihost, taskhostw, RuntimeBroker, dllhost, ctfmon — otasi
//     session 0 jarayoni, winlogon yoki userinit bo'lsa; %SystemRoot%\explorer.exe — faqat userinit'dan → tegilmaydi
//     (bloklash kirishdan oldin boshlangan bo'lsa ham ish stoli yuklansin);
//   - baseline'dagi (bloklash boshlanganda sessiyada bo'lgan) jarayon → tegilmaydi (o'quvchining ochiq ishi);
//   - baseline'da bo'lmagan jarayon faqat bir xil dastur avlodi bo'lsa yashaydi: ParentPID zanjiri tirik baseline
//     ajdodga yetadi va jarayonning o'zi, oradagi har bir jarayon va o'sha ajdod aynan bir xil yo'lli exe (masalan,
//     chrome.exe → chrome.exe renderer, brauzerning yangi tablari). Zanjirda boshqa exe bo'lsa → o'ldiriladi. Shunday
//     qilib baseline cmd/powershell, eski dasturning fayl dialogi, explorer, sihost, RuntimeBroker yoki
//     PROC_THREAD_ATTRIBUTE_PARENT_PROCESS bilan baseline otani ko'rsatgan jarayon orqali yangi dastur ochib bo'lmaydi
//     (ParentPID'ga ishonch faqat "o'sha dasturning o'zi" doirasida);
//   - qolgani (yangi ildizdan boshlangan, ota-onasi topilmagan yoki ishonchsiz) → o'ldiriladi.
//
// Yo'li o'qilmagan jarayon (Image == "", masalan himoyalangan jarayon): baseline'da bo'lsa yashaydi, aks holda
// o'ldiriladi (yo'lni tekshirib bo'lmaydi; fail-closed).
package procguard

import (
	"strings"
	"time"
)

// maxDepth ajdodlar zanjirining yuqori chegarasi (tsikldan himoya visited bilan; bu qo'shimcha to'siq).
const maxDepth = 64

// Proc snapshot'dagi bitta jarayon.
type Proc struct {
	PID, ParentPID, Session uint32
	// Image to'liq yo'l, kichik harf (Normalize). Bo'sh — yo'l o'qilmadi.
	Image string
	// Created yaratilish vaqti (GetProcessTimes). Nol — o'qilmadi.
	Created time.Time
	// Stale Toolhelp'dagi ParentPID ishonchsiz (jarayon snapshot boshlanganidan keyin yaratilgan, ya'ni PID shu
	// orada qayta berilgan bo'lishi mumkin). Bu safar qaror qilinmaydi, keyingi snapshot'da qayta ko'riladi.
	Stale bool
}

// Allow ruxsat ro'yxati. Hamma yo'llar normallashtirilgan (Normalize); kataloglar oxiri `\` bilan.
type Allow struct {
	// NetSchoolDir `%ProgramFiles%\NetSchool\`: ichidagi exe faqat helper xizmati (Trusted) ochgan bo'lsa yashaydi
	// (helperChain). Baseline va avlod qoidalari unga qo'llanmaydi.
	NetSchoolDir string
	// MeshDir `%ProgramFiles%\Mesh Agent\`: ichidagi exe faqat session 0 jarayoni ochgan bo'lsa yashaydi (meshChain).
	MeshDir string
	// Images har doim ruxsat etilgan tizim jarayonlari (aniq moslik).
	Images []string
	// Kill baseline'da bo'lsa ham o'ldiriladigan exe'lar (aniq moslik).
	Kill []string
	// LogonImages kirish (logon) paytida shell ochadigan System32 jarayonlari: otasi session 0 jarayoni yoki
	// LogonParents'dan biri bo'lsa yashaydi.
	LogonImages []string
	// LogonParents System32 winlogon.exe va userinit.exe.
	LogonParents []string
	// Explorer `%SystemRoot%\explorer.exe`: faqat userinit (LogonParents'dagi userinit) ochgan bo'lsa yashaydi.
	Explorer string
	// Userinit `%SystemRoot%\System32\userinit.exe`.
	Userinit string
	// Trusted helper xizmati jarayonlarining PID'lari (Scanner o'zini beradi; xizmat tirik ekan PID qayta berilmaydi).
	Trusted map[uint32]bool
}

// system32Images %SystemRoot%\System32\ ichidagi ruxsat etilgan tizim jarayonlari (bloklash/kirish ekrani, matn
// kiritish, xato hisoboti uchun kerak).
var system32Images = []string{
	"conhost.exe", "dwm.exe", "csrss.exe", "fontdrvhost.exe", "ctfmon.exe",
	"LogonUI.exe", "consent.exe", "WerFault.exe", "SystemSettingsBroker.exe",
}

// logonImages kirish paytida (bloklash kirishdan oldin boshlangan bo'lsa ham) yashashi kerak bo'lgan System32 shell
// jarayonlari. Ular session 0 xizmatlari (svchost: DcomLaunch, Schedule), winlogon yoki userinit'dan ochiladi.
var logonImages = []string{"userinit.exe", "sihost.exe", "taskhostw.exe", "RuntimeBroker.exe", "dllhost.exe", "ctfmon.exe"}

// textInputHost Windows 10 21H1+ va 11 dagi sensorli klaviatura / emoji paneli, %SystemRoot%'ga nisbatan.
const textInputHost = `SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\TextInputHost.exe`

// maxHelperDepth helper xizmatidan NetSchool exe'gacha bo'g'inlar: xizmat → Companion/guard (1) → Electron bolasi
// (2). Chuqurroq zanjir (masalan, o'quvchi Electron bolasini PROC_THREAD_ATTRIBUTE_PARENT_PROCESS bilan ota qilib
// Companion exe'sini ochgan) yashamaydi.
const maxHelperDepth = 2

// DefaultAllow %ProgramFiles% va %SystemRoot% (ishga tushish vaqtida aniqlangan) bo'yicha ruxsat ro'yxatini yasaydi.
// trusted — helper xizmati PID'lari. Bo'sh ildiz o'tkazib yuboriladi (nisbiy yo'l hech qachon ruxsat bo'lmasin).
func DefaultAllow(programFiles, systemRoot string, trusted ...uint32) Allow {
	a := Allow{Trusted: map[uint32]bool{}}
	for _, pid := range trusted {
		a.Trusted[pid] = true
	}
	if pf := trimSep(Normalize(programFiles)); pf != "" {
		a.NetSchoolDir, a.MeshDir = pf+`\netschool\`, pf+`\mesh agent\`
	}
	if root := trimSep(Normalize(systemRoot)); root != "" {
		sys32 := root + `\System32\`
		for _, name := range system32Images {
			a.Images = append(a.Images, Normalize(sys32+name))
		}
		a.Images = append(a.Images, Normalize(root+`\`+textInputHost))
		a.Kill = append(a.Kill, Normalize(sys32+`taskmgr.exe`))
		for _, name := range logonImages {
			a.LogonImages = append(a.LogonImages, Normalize(sys32+name))
		}
		a.Userinit = Normalize(sys32 + `userinit.exe`)
		a.LogonParents = []string{Normalize(sys32 + `winlogon.exe`), a.Userinit}
		a.Explorer = Normalize(root + `\explorer.exe`)
	}
	return a
}

// Normalize yo'lni solishtirish uchun bir xil ko'rinishga keltiradi: kichik harf, `/` → `\`, `\\?\` prefiksi olib
// tashlanadi (`\\?\UNC\` → `\\`).
func Normalize(p string) string {
	p = strings.ReplaceAll(p, "/", `\`)
	switch {
	case hasPrefixFold(p, `\\?\UNC\`):
		p = `\\` + p[len(`\\?\UNC\`):]
	case strings.HasPrefix(p, `\\?\`):
		p = p[len(`\\?\`):]
	}
	return strings.ToLower(p)
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

func trimSep(p string) string { return strings.TrimRight(p, `\`) }

// inDir image dir katalogi ichidami (dir bo'sh emas va `\` bilan tugaydi).
func inDir(image, dir string) bool {
	return image != "" && dir != "" && strings.HasSuffix(dir, `\`) && strings.HasPrefix(image, dir)
}

func contains(list []string, image string) bool {
	for _, v := range list {
		if v != "" && v == image {
			return true
		}
	}
	return false
}

// Decide p o'ldirilishi kerakmi (true = o'ldirish). session — o'quvchi sessiyasi, baseline — bloklash boshlanganda
// sessiyada bo'lgan (va hali o'sha jarayon bo'lgan, Baseline.Live) PID'lar, procs — joriy snapshot (hamma sessiyalar).
//
// Ajdod zanjiri ParentPID bo'yicha yuriladi, faqat p bilan bir xil yo'lli jarayonlar orqali. PID qayta ishlatilishi
// mumkin, shuning uchun ota faqat u boladan oldin yaratilgan bo'lsa ota hisoblanadi; vaqti noma'lum (nol) yoki
// Stale bo'lsa ishonilmaydi. Tsikl visited va maxDepth bilan to'xtatiladi.
func Decide(p Proc, session uint32, baseline map[uint32]bool, procs map[uint32]Proc, allow Allow) bool {
	if p.Session != session || p.PID == 0 || p.PID == 4 || p.Stale {
		return false
	}
	image := Normalize(p.Image)
	switch {
	case inDir(image, allow.NetSchoolDir):
		return !helperChain(p, procs, allow)
	case inDir(image, allow.MeshDir):
		return !meshChain(p, procs, allow)
	case contains(allow.Images, image):
		return false
	case contains(allow.Kill, image):
		return true
	case logonShell(p, image, procs, allow):
		return false
	case baseline[p.PID]:
		return false
	case image == "":
		return true
	}
	visited := map[uint32]bool{p.PID: true}
	cur := p
	for range maxDepth {
		parent, ok := procs[cur.ParentPID]
		if !ok || visited[parent.PID] || !trustedParent(parent, cur) || Normalize(parent.Image) != image {
			return true
		}
		if baseline[parent.PID] {
			return false
		}
		visited[parent.PID] = true
		cur = parent
	}
	return true
}

// helperChain NetSchool exe'si helper xizmatining bolasi yoki (maxHelperDepth gacha) NetSchool exe'lari orqali
// nevarasi. Har bo'g'inda ota boladan oldin yaratilgan bo'lishi shart (trustedParent).
func helperChain(p Proc, procs map[uint32]Proc, allow Allow) bool {
	cur := p
	for range maxHelperDepth {
		parent, ok := procs[cur.ParentPID]
		if !ok || parent.PID == cur.PID || !trustedParent(parent, cur) {
			return false
		}
		if allow.Trusted[parent.PID] {
			return true
		}
		if !inDir(Normalize(parent.Image), allow.NetSchoolDir) {
			return false
		}
		cur = parent
	}
	return false
}

// meshChain Mesh Agent exe'si session 0 jarayonining (MeshAgent xizmati) bolasi yoki faqat Mesh Agent exe'lari orqali
// avlodi.
func meshChain(p Proc, procs map[uint32]Proc, allow Allow) bool {
	visited := map[uint32]bool{p.PID: true}
	cur := p
	for range maxDepth {
		parent, ok := procs[cur.ParentPID]
		if !ok || visited[parent.PID] || !trustedParent(parent, cur) {
			return false
		}
		if parent.Session == 0 {
			return true
		}
		if !inDir(Normalize(parent.Image), allow.MeshDir) {
			return false
		}
		visited[parent.PID] = true
		cur = parent
	}
	return false
}

// logonShell kirish paytidagi shell jarayonimi: LogonImages'dagi exe otasi session 0 jarayoni yoki winlogon/userinit
// bo'lsa; explorer faqat userinit'dan. Bloklash kirishdan oldin boshlanganda (yoki dars paytida RuntimeBroker,
// dllhost kabi COM jarayonlari) ish stoli yuklanishi uchun.
func logonShell(p Proc, image string, procs map[uint32]Proc, allow Allow) bool {
	isLogonImage := contains(allow.LogonImages, image)
	if !isLogonImage && (allow.Explorer == "" || image != allow.Explorer) {
		return false
	}
	parent, ok := procs[p.ParentPID]
	if !ok || parent.PID == p.PID || !trustedParent(parent, p) {
		return false
	}
	parentImage := Normalize(parent.Image)
	if !isLogonImage {
		return allow.Userinit != "" && parentImage == allow.Userinit
	}
	return parent.Session == 0 || contains(allow.LogonParents, parentImage)
}

// Baseline bloklash boshlanganda o'quvchi sessiyasida bo'lgan jarayonlar: PID → o'sha paytdagi jarayon.
type Baseline map[uint32]Proc

// NewBaseline snapshot'dan session'dagi jarayonlarni oladi (Stale'lar kirmaydi: keyingi snapshot'da oddiy yangi
// jarayon sifatida ko'riladi).
func NewBaseline(procs map[uint32]Proc, session uint32) Baseline {
	b := Baseline{}
	for pid, p := range procs {
		if p.Session == session && !p.Stale {
			b[pid] = p
		}
	}
	return b
}

// Live joriy snapshot'da hali o'sha jarayon bo'lib turgan baseline PID'lari (Decide'ning baseline argumenti). PID
// qayta ishlatilishi mumkin: yaratilish vaqti, sessiya yoki yo'li o'zgargan PID baseline emas.
func (b Baseline) Live(procs map[uint32]Proc) map[uint32]bool {
	live := make(map[uint32]bool, len(b))
	for pid, was := range b {
		now, ok := procs[pid]
		if ok && now.Session == was.Session && now.Created.Equal(was.Created) && Normalize(now.Image) == Normalize(was.Image) {
			live[pid] = true
		}
	}
	return live
}

// procKey jarayonni PID qayta ishlatilishidan ajratadi.
type procKey struct {
	pid     uint32
	created time.Time
}

// staleTracker Stale istisnosini har jarayonga ko'pi bilan bitta scan beradi. Stale belgisi "jarayon snapshot
// boshlanganidan keyin yaratilgan" degani; soat orqaga ketsa (NTP qadami, Set-Date) bu shart har scan'da rost
// bo'lib qolishi va jarayon hech qachon baholanmasligi mumkin edi (fail-open). Shuning uchun oldingi scan'da ham
// Stale bo'lgan kalit (PID + Created) uchun belgi olib tashlanadi va jarayon oddiy qaror bilan baholanadi.
type staleTracker struct {
	prev map[procKey]bool // oldingi scan'dagi Stale kalitlar
}

// Round shu scan'ning procs'ini tuzatadi va oldingi to'plamni shu scan'dagi Stale kalitlar bilan almashtiradi
// (cheksiz o'smaydi). Belgisi olib tashlangan kalit ham to'plamda qoladi: u Stale bo'lib turgan har keyingi scan'da
// ham baholanadi, ya'ni istisno kalitga bir marta beriladi.
func (t *staleTracker) Round(procs map[uint32]Proc) {
	cur := map[procKey]bool{}
	for pid, p := range procs {
		if !p.Stale {
			continue
		}
		key := procKey{pid, p.Created}
		cur[key] = true
		if t.prev[key] {
			p.Stale = false
			procs[pid] = p
		}
	}
	t.prev = cur
}

// trustedParent parent haqiqatan child'ning otasi bo'lishi mumkinmi: ikkala vaqt ma'lum va ota boladan keyin
// yaratilmagan.
func trustedParent(parent, child Proc) bool {
	if parent.Stale || parent.Created.IsZero() || child.Created.IsZero() {
		return false
	}
	return !parent.Created.After(child.Created)
}
