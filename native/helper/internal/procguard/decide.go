// Package procguard bloklash paytida o'quvchi sessiyasida yangi ochilgan dasturlarni to'xtatadi (process guard).
//
// Qaror toza mantiq (Decide), har OS'da test qilinadi; snapshot va TerminateProcess scan_windows.go'da.
//
// Qoida (ADR 0014):
//   - boshqa sessiyadagi jarayon, PID 0 va 4 → tegilmaydi; Toolhelp'dagi ota PID'i eskirgan (Stale) jarayon → bu
//     safar tegilmaydi, keyingi snapshot'da qayta ko'riladi;
//   - Allow.Dirs (%ProgramFiles%\NetSchool\, %ProgramFiles%\Mesh Agent\) ichidagi yoki Allow.Images'dagi (to'liq yo'l
//     bilan) jarayon → tegilmaydi. Ruxsat etilgan jarayon boshqalar uchun ishonchli ajdod emas;
//   - Allow.Kill'dagi jarayon (%SystemRoot%\System32\taskmgr.exe) → baseline'da bo'lsa ham o'ldiriladi: bloklashdan
//     oldin ochilgan Task Manager bilan Companion'ni yoki boshqa jarayonni to'xtatish mumkin edi;
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

// Allow ruxsat ro'yxati. Dirs — normallashtirilgan, oxiri `\` bilan tugaydigan kataloglar (prefiks bo'yicha);
// Images — normallashtirilgan to'liq yo'llar (aniq moslik). Kill — baseline'da bo'lsa ham o'ldiriladigan to'liq
// yo'llar (aniq moslik).
type Allow struct {
	Dirs   []string
	Images []string
	Kill   []string
}

// system32Images %SystemRoot%\System32\ ichidagi ruxsat etilgan tizim jarayonlari (bloklash/kirish ekrani, matn
// kiritish, xato hisoboti uchun kerak).
var system32Images = []string{
	"conhost.exe", "dwm.exe", "csrss.exe", "fontdrvhost.exe", "ctfmon.exe",
	"LogonUI.exe", "consent.exe", "WerFault.exe", "SystemSettingsBroker.exe",
}

// textInputHost Windows 10 21H1+ va 11 dagi sensorli klaviatura / emoji paneli, %SystemRoot%'ga nisbatan.
const textInputHost = `SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\TextInputHost.exe`

// DefaultAllow %ProgramFiles% va %SystemRoot% (ishga tushish vaqtida aniqlangan) bo'yicha ruxsat ro'yxatini yasaydi.
// Bo'sh ildiz o'tkazib yuboriladi (nisbiy yo'l hech qachon ruxsat bo'lmasin).
func DefaultAllow(programFiles, systemRoot string) Allow {
	var a Allow
	if pf := trimSep(Normalize(programFiles)); pf != "" {
		a.Dirs = append(a.Dirs, pf+`\netschool\`, pf+`\mesh agent\`)
	}
	if root := trimSep(Normalize(systemRoot)); root != "" {
		for _, name := range system32Images {
			a.Images = append(a.Images, Normalize(root+`\System32\`+name))
		}
		a.Images = append(a.Images, Normalize(root+`\`+textInputHost))
		a.Kill = append(a.Kill, Normalize(root+`\System32\taskmgr.exe`))
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

func (a Allow) allows(image string) bool {
	if image == "" {
		return false
	}
	for _, d := range a.Dirs {
		if d != "" && strings.HasSuffix(d, `\`) && strings.HasPrefix(image, d) {
			return true
		}
	}
	return contains(a.Images, image)
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
	if allow.allows(image) {
		return false
	}
	if contains(allow.Kill, image) {
		return true
	}
	if baseline[p.PID] {
		return false
	}
	if image == "" {
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
