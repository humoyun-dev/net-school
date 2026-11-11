// Package policy bloklash vaqtida o'rnatiladigan reyestr siyosatini (Ctrl+Alt+Del bandlari, Win+L, tez almashtirish)
// yozadi va jurnal bo'yicha qaytaradi. Reyestrning o'ziga kirish `Registry` portida (Windows realizatsiyasi
// `registry_windows.go`), shuning uchun mantiq har OS'da test qilinadi.
//
// Bu Companion'dagi `apps/companion/src/core/lock-policy.ts` bilan bir xil g'oya, faqat helper SYSTEM'da ishlaydi:
// seans foydalanuvchisining hive'iga (`HKU\<SID>`) yozadi, shuning uchun jurnal har yozuv uchun SID'ni saqlaydi.
package policy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Registry reyestr qiymatlariga (faqat REG_DWORD) kirish porti.
//
// root `HKLM` yoki `HKU\<SID>`; key hive'siz yo'l (`Software\Microsoft\...`). Read kalit yoki qiymat yo'q bo'lsa
// (nil, nil) qaytaradi. Write kalit yo'q bo'lsa yaratadi. Delete qiymat allaqachon yo'q bo'lsa xato emas.
type Registry interface {
	Read(root, key, name string) (*uint32, error)
	Write(root, key, name string, v uint32) error
	Delete(root, key, name string) error
}

const (
	hiveMachine = "HKLM"
	hiveUsers   = "HKU"
)

// sidPattern `S-1-<authority>-<subauthority>...` ko'rinishidagi SID. Qat'iy tekshiriladi, chunki SID reyestr
// yo'liga qo'shiladi: `..` yoki `\` bilan boshqa kalitga chiqib ketib bo'lmasligi kerak.
var sidPattern = regexp.MustCompile(`^S-1-[0-9]{1,15}(-[0-9]{1,10}){1,15}$`)

func userRoot(sid string) string { return hiveUsers + `\` + sid }

// parseRoot root satrini hive (`HKLM` | `HKU`) va (HKU uchun) SID'ga ajratadi. Boshqa hamma narsa xato.
func parseRoot(root string) (hive, sid string, err error) {
	if root == hiveMachine {
		return hiveMachine, "", nil
	}
	if rest, ok := strings.CutPrefix(root, hiveUsers+`\`); ok && sidPattern.MatchString(rest) {
		return hiveUsers, rest, nil
	}
	return "", "", fmt.Errorf("reyestr root'i yaroqsiz (HKLM yoki HKU\\<SID> bo'lishi kerak): %q", root)
}

const (
	userSystemKey   = `Software\Microsoft\Windows\CurrentVersion\Policies\System`
	userExplorerKey = `Software\Microsoft\Windows\CurrentVersion\Policies\Explorer`
	machineSystem   = `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`
)

// valueSpec bloklash siyosatining bitta qiymati; hammasi REG_DWORD 1.
type valueSpec struct {
	machine bool // true: HKLM (foydalanuvchiga bog'liq emas); false: HKU\<SID>
	key     string
	name    string
}

// lockValues bloklash siyosati (spetsifikatsiya: Global Constraints).
var lockValues = []valueSpec{
	{false, userSystemKey, "DisableTaskMgr"},
	{false, userSystemKey, "DisableLockWorkstation"},
	{false, userSystemKey, "DisableChangePassword"},
	{false, userExplorerKey, "NoLogoff"},
	{false, userExplorerKey, "NoClose"},
	{true, machineSystem, "HideFastUserSwitching"},
}

// journalEntry jurnalning bir yozuvi. Previous nil — qiymat yo'q edi (tiklashda o'chiriladi).
// SID HKU yozuvlarida seans foydalanuvchisi; HKLM yozuvi mashinaga tegishli, shuning uchun SID bo'sh
// (foydalanuvchi almashganda HKLM qiymati tiklanmaydi va bloklashda bo'shliq paydo bo'lmaydi).
type journalEntry struct {
	Root     string  `json:"root"`
	Key      string  `json:"key"`
	Name     string  `json:"name"`
	Previous *uint32 `json:"previous"`
	SID      string  `json:"sid"`
}

func (e journalEntry) sameValue(o journalEntry) bool {
	return e.Root == o.Root && e.Key == o.Key && e.Name == o.Name
}

func (e journalEntry) String() string { return e.Root + `\` + e.Key + ` [` + e.Name + `]` }

// validate yozuvning ichki izchilligini tekshiradi: root yaroqli, SID root'ga mos, key/name bo'sh emas.
func (e journalEntry) validate() error {
	hive, sid, err := parseRoot(e.Root)
	if err != nil {
		return err
	}
	if e.SID != sid {
		return fmt.Errorf("yozuv SID'i (%q) root'ga (%q) mos emas", e.SID, e.Root)
	}
	if hive == hiveMachine && e.SID != "" {
		return errors.New("HKLM yozuvida SID bo'lmasligi kerak")
	}
	if e.Key == "" || e.Name == "" {
		return errors.New("yozuvda key yoki name bo'sh")
	}
	return nil
}

// Policy bloklash siyosatini yozadi va jurnal bo'yicha qaytaradi. Metodlar bir-biriga nisbatan ketma-ket
// bajariladi (bir nechta goroutine'dan chaqirish xavfsiz).
type Policy struct {
	mu          sync.Mutex
	reg         Registry
	journalPath string
}

// NewPolicy jurnalni journalPath'da (`%ProgramData%\NetSchool\helper\policy-journal.json`) saqlaydi.
// Katalogni yaratish va uning ACL'i (faqat SYSTEM va Administrators) xizmatning ishi.
func NewPolicy(reg Registry, journalPath string) *Policy {
	return &Policy{reg: reg, journalPath: journalPath}
}

// Apply siyosatni userSID foydalanuvchisi uchun o'rnatadi. Takroriy chaqiruv xavfsiz: jurnalda bor qiymatning
// "oldingi" holati qayta yozilmaydi (aks holda bizning o'z qiymatimiz "asl" deb saqlanib qolardi), qiymatlar esa
// qayta o'rnatiladi.
//
// Tartib: boshqa foydalanuvchining qoldiq yozuvlari tiklanadi; yangi yozuvlar uchun oldingi qiymatlar o'qiladi;
// jurnal diskka yoziladi; shundan keyingina qiymatlar yoziladi. Shunda yozish o'rtasida uzilsa ham hammasini
// qaytarish mumkin.
//
// Xato bo'lsa ham iloji boricha ko'proq qiymat yoziladi (bitta qiymat yiqilsa, qolganlari bloklashni ushlab turadi).
// Boshqa foydalanuvchining qoldig'i tiklanmasa (masalan, uning hive'i yuklanmagan), u jurnalda qoladi, yangi
// foydalanuvchi baribir bloklanadi va xato qaytariladi; keyingi Apply/Restore qayta urinadi.
func (p *Policy) Apply(userSID string) error {
	if !sidPattern.MatchString(userSID) {
		return fmt.Errorf("foydalanuvchi SID'i yaroqsiz: %q", userSID)
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	journal, err := p.load()
	if err != nil {
		return err
	}

	// 1. Boshqa foydalanuvchining qoldiq yozuvlari avval tiklanadi (HKLM yozuvi hech kimniki emas, tegilmaydi).
	count := len(journal)
	journal, staleErr := p.restoreMatching(journal, func(e journalEntry) bool { return e.SID != "" && e.SID != userSID })
	if len(journal) != count {
		if err := p.save(journal); err != nil {
			return errors.Join(staleErr, err)
		}
	}

	// 2. Jurnalda yo'q qiymatlarning oldingi holati o'qiladi. Xato bo'lsa hali hech narsa yozilmagan.
	targets := make([]journalEntry, 0, len(lockValues))
	changed := false
	for _, v := range lockValues {
		t := journalEntry{Root: hiveMachine, Key: v.key, Name: v.name}
		if !v.machine {
			t.Root, t.SID = userRoot(userSID), userSID
		}
		targets = append(targets, t)
		if containsValue(journal, t) {
			continue
		}
		t.Previous, err = p.reg.Read(t.Root, t.Key, t.Name)
		if err != nil {
			return errors.Join(staleErr, fmt.Errorf("%s o'qilmadi: %w", t, err))
		}
		journal = append(journal, t)
		changed = true
	}

	// 3. Avval jurnal, keyin qiymatlar.
	if changed {
		if err := p.save(journal); err != nil {
			return errors.Join(staleErr, err)
		}
	}
	errs := []error{staleErr}
	for _, t := range targets {
		if err := p.reg.Write(t.Root, t.Key, t.Name, 1); err != nil {
			errs = append(errs, fmt.Errorf("%s yozilmadi: %w", t, err))
		}
	}
	return errors.Join(errs...)
}

// Restore jurnal bo'yicha hamma qiymatni oldingi holatiga qaytaradi. Tiklanmagan yozuvlar jurnalda qoladi va xato
// qaytariladi (keyingi urinish davom ettiradi). To'liq tiklansa jurnal fayli o'chiriladi.
func (p *Policy) Restore() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	journal, err := p.load()
	if err != nil {
		return err
	}
	remaining, restoreErr := p.restoreMatching(journal, func(journalEntry) bool { return true })
	if err := p.save(remaining); err != nil {
		return errors.Join(restoreErr, err)
	}
	return restoreErr
}

// Pending tiklanishi kerak bo'lgan yozuv borligini bildiradi. Jurnal o'qilmasa ham true: qaytarish kerak bo'lgan
// holatni "yo'q" deb o'ylamaymiz.
func (p *Policy) Pending() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	journal, err := p.load()
	return err != nil || len(journal) > 0
}

// restoreMatching match qaytargan yozuvlarni tiklaydi. Qaytariladigan ro'yxatda mos kelmaganlar va tiklanmaganlar
// bor (tartib saqlanadi); xato — tiklanmaganlarning birlashtirilgan xatosi.
func (p *Policy) restoreMatching(entries []journalEntry, match func(journalEntry) bool) ([]journalEntry, error) {
	var remaining []journalEntry
	var errs []error
	for _, e := range entries {
		if !match(e) {
			remaining = append(remaining, e)
			continue
		}
		var err error
		if e.Previous == nil {
			err = p.reg.Delete(e.Root, e.Key, e.Name)
		} else {
			err = p.reg.Write(e.Root, e.Key, e.Name, *e.Previous)
		}
		if err != nil {
			remaining = append(remaining, e)
			errs = append(errs, fmt.Errorf("%s tiklanmadi: %w", e, err))
		}
	}
	return remaining, errors.Join(errs...)
}

func containsValue(entries []journalEntry, t journalEntry) bool {
	for _, e := range entries {
		if e.sameValue(t) {
			return true
		}
	}
	return false
}

// load jurnalni qat'iy o'qiydi (fayl yo'q bo'lsa bo'sh ro'yxat). Buzilgan jurnal "yo'q" deb o'qilmaydi:
// qaytarish mumkin bo'lmagan holatni jimgina yo'qotmaslik uchun xato qaytaradi va fayl o'zgartirilmaydi.
func (p *Policy) load() ([]journalEntry, error) {
	raw, err := os.ReadFile(p.journalPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("policy-journal.json o'qilmadi: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var entries []journalEntry
	if err := dec.Decode(&entries); err != nil {
		return nil, fmt.Errorf("policy-journal.json noto'g'ri: %w", err)
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("policy-journal.json'da ortiqcha ma'lumot bor")
	}
	for i, e := range entries {
		if err := e.validate(); err != nil {
			return nil, fmt.Errorf("policy-journal.json: %d-yozuv yaroqsiz: %w", i, err)
		}
	}
	return entries, nil
}

// save jurnalni atomik yozadi: shu katalogdagi vaqtinchalik faylga yozib, fsync qilib, nishon ustiga rename qiladi
// (yarim yozilgan jurnal hech qachon ko'rinmaydi). Bo'sh ro'yxat faylni o'chiradi.
func (p *Policy) save(entries []journalEntry) (err error) {
	if len(entries) == 0 {
		if err := os.Remove(p.journalPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("policy-journal.json o'chirilmadi: %w", err)
		}
		return nil
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p.journalPath), ".policy-*.tmp")
	if err != nil {
		return fmt.Errorf("policy-journal.json vaqtinchalik fayli ochilmadi: %w", err)
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), p.journalPath); err != nil {
		return fmt.Errorf("policy-journal.json almashtirilmadi: %w", err)
	}
	return nil
}
