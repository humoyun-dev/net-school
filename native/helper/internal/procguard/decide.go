// Package procguard bloklash paytida o'quvchi sessiyasida yangi ochilgan dasturlarni to'xtatadi (process guard).
//
// Qaror toza mantiq (Decide), har OS'da test qilinadi; snapshot va TerminateProcess scan_windows.go'da.
//
// Qoida (ADR 0014):
//   - boshqa sessiyadagi jarayon, PID 0 va 4 → tegilmaydi;
//   - Allow.Dirs (%ProgramFiles%\NetSchool\, %ProgramFiles%\Mesh Agent\) ichidagi yoki Allow.Images'dagi (to'liq yo'l
//     bilan) jarayon → tegilmaydi;
//   - baseline'dagi (bloklash boshlanganda sessiyada bo'lgan) jarayon va uning avlodi → tegilmaydi (o'quvchining ochiq
//     ishi va, masalan, brauzerning yangi tablari). Istisno: yangi jarayonning o'zi yoki zanjirdagi baseline'gacha
//     bo'lgan biror ajdodi explorer.exe, taskmgr.exe, sihost.exe yoki RuntimeBroker.exe bo'lsa (ular baseline'da
//     bo'lsa ham) → o'ldiriladi: bu dasturlar o'quvchiga yangi dastur ochish yo'li;
//   - qolgani (yangi ildizdan boshlangan, ota-onasi topilmagan yoki ishonchsiz) → o'ldiriladi.
//
// Yo'li o'qilmagan jarayon (Image == "", masalan himoyalangan jarayon): baseline'da bo'lsa yashaydi, aks holda avlod
// qoidasi qo'llanmaydi va o'ldiriladi (ruxsat ro'yxatini yo'l bo'yicha tekshirib bo'lmaydi; fail-closed).
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
}

// Allow ruxsat ro'yxati. Dirs — normallashtirilgan, oxiri `\` bilan tugaydigan kataloglar (prefiks bo'yicha);
// Images — normallashtirilgan to'liq yo'llar (aniq moslik).
type Allow struct {
	Dirs   []string
	Images []string
}

// launchers bu nomli jarayonlar o'quvchiga yangi dastur ochish imkonini beradi: ulardan keyin kelgan jarayon baseline
// avlodi bo'lsa ham o'ldiriladi. Nom bo'yicha (yo'l emas): boshqa joydagi shu nomli exe ham ishga tushiruvchi
// hisoblanadi, bu faqat o'ldirish tomoniga xato qiladi.
var launchers = map[string]bool{
	"explorer.exe":      true,
	"taskmgr.exe":       true,
	"sihost.exe":        true,
	"runtimebroker.exe": true,
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

// baseName yo'lning oxirgi qismi.
func baseName(p string) string {
	if i := strings.LastIndexByte(p, '\\'); i >= 0 {
		return p[i+1:]
	}
	return p
}

func (a Allow) allows(image string) bool {
	if image == "" {
		return false
	}
	for _, d := range a.Dirs {
		if d != "" && strings.HasSuffix(d, `\`) && strings.HasPrefix(image, d) {
			return true
		}
	}
	for _, img := range a.Images {
		if img != "" && image == img {
			return true
		}
	}
	return false
}

// isLauncher jarayon ishga tushiruvchi (explorer, taskmgr, sihost, RuntimeBroker).
func isLauncher(image string) bool { return launchers[baseName(image)] }

// Decide p o'ldirilishi kerakmi (true = o'ldirish). session — o'quvchi sessiyasi, baseline — bloklash boshlanganda
// sessiyada bo'lgan (va hali o'sha jarayon bo'lgan) PID'lar, procs — joriy snapshot (hamma sessiyalar).
//
// Ajdod zanjiri ParentPID bo'yicha yuriladi. PID qayta ishlatilishi mumkin, shuning uchun ota faqat u boladan oldin
// yaratilgan bo'lsa ota hisoblanadi; vaqti noma'lum (nol) bo'lsa ishonilmaydi va zanjir uziladi. Tsikl visited
// bilan to'xtatiladi.
func Decide(p Proc, session uint32, baseline map[uint32]bool, procs map[uint32]Proc, allow Allow) bool {
	if p.Session != session || p.PID == 0 || p.PID == 4 {
		return false
	}
	image := Normalize(p.Image)
	if allow.allows(image) {
		return false
	}
	if baseline[p.PID] {
		return false
	}
	if image == "" || isLauncher(image) {
		return true
	}
	visited := map[uint32]bool{p.PID: true}
	cur := p
	for range maxDepth {
		parent, ok := procs[cur.ParentPID]
		if !ok || visited[parent.PID] || !trustedParent(parent, cur) {
			return true
		}
		visited[parent.PID] = true
		if isLauncher(Normalize(parent.Image)) {
			return true
		}
		if baseline[parent.PID] {
			return false
		}
		cur = parent
	}
	return true
}

// Baseline bloklash boshlanganda o'quvchi sessiyasida bo'lgan jarayonlar: PID → o'sha paytdagi jarayon.
type Baseline map[uint32]Proc

// NewBaseline snapshot'dan session'dagi jarayonlarni oladi.
func NewBaseline(procs map[uint32]Proc, session uint32) Baseline {
	b := Baseline{}
	for pid, p := range procs {
		if p.Session == session {
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

// trustedParent parent haqiqatan child'ning otasi bo'lishi mumkinmi: ikkala vaqt ma'lum va ota boladan keyin
// yaratilmagan.
func trustedParent(parent, child Proc) bool {
	if parent.Created.IsZero() || child.Created.IsZero() {
		return false
	}
	return !parent.Created.After(child.Created)
}
