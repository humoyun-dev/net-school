// Package cad bloklash vaqtida Ctrl+Alt+Del (Windows Security ekrani) va Win+L'ni Windows Keyboard Filter orqali
// to'sadi, u bor nashrlarda (Education, Enterprise, IoT Enterprise). Qolgan nashrlarda (Pro, Home) `unavailable`
// qaytadi, sababi `edition`: to'liq to'sish u yerda bu rejaga kirmaydi (reja: "Ochiq qaror").
//
// Backend (Windows realizatsiyasi `kbfilter_windows.go`) tashqi jarayon (powershell.exe) ishga tushiradi, Guard esa
// toza mantiq: har OS'da soxta Backend bilan test qilinadi.
//
// Qulash xavfsizligi: Keyboard Filter sozlamasi reyestr kabi doimiy (reboot'dan keyin ham saqlanadi), ya'ni helper
// bloklash paytida qulasa yoki kompyuter o'chib qolsa, Ctrl+Alt+Del bloklangan holda qolib ketadi. Shuning uchun
// Block'dan OLDIN jurnal (`cad-journal.json`, `%ProgramData%\NetSchool\helper\`) atomik yoziladi, Unblock
// muvaffaqiyatli bo'lgachgina o'chiriladi, helper keyingi ishga tushishda (Start) jurnalda qoldiq bo'lsa filtrni
// o'chiradi.
package cad

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Guard holatlari (contracts'dagi helperStatusSchema `cad` maydoni bilan bir xil).
const (
	StateBlocked     = "blocked"     // filtr yoqilgan, Ctrl+Alt+Del to'silgan
	StateUnavailable = "unavailable" // bu Windows nashrida Keyboard Filter yo'q (sabab: edition)
	StateFailed      = "failed"      // Block/Unblock yoki jurnal yozish yiqilgan, yoki mavjudlik aniqlanmagan
	StateOff         = "off"         // filtr bizning tomonimizdan yoqilmagan
)

// ReasonEdition Backend.Available shu sababni qaytarsa, nashrda Keyboard Filter yo'q (Guard `unavailable` deydi).
// Boshqa har qanday sabab (probe xatosi) `failed`: nashr cheklovi emas, qayta urinish mumkin.
const ReasonEdition = "edition"

// Backend Keyboard Filter'ni boshqaradi. Block va Unblock idempotent bo'lishi kerak (yoqilgan filtrni yana yoqish
// yoki o'chirilganni yana o'chirish xato emas).
type Backend interface {
	// Available filtr shu kompyuterda ishlashi mumkinmi. false bo'lsa ikkinchi qiymat sabab: ReasonEdition yoki
	// probe xatosi matni.
	Available() (bool, string)
	Block(ctx context.Context) error
	Unblock(ctx context.Context) error
}

// journalBlocked jurnal faylidagi holat. Mazmuni faqat diagnostika uchun (administrator fayl ichida nima
// borligini ko'radi): "qaytarish kerak" degan qaror fayl borligining o'ziga tayanadi (journalPending).
const journalBlocked = "blocked"

type journal struct {
	State string `json:"state"`
}

// Guard bloklash holatiga qarab Backend'ni boshqaradi va qulashga bardoshli jurnal yuritadi.
//
// Set/Start bir-biriga nisbatan ketma-ket bajariladi (sekin PowerShell chaqiruvi paytida ham). State va Reason
// esa shu qulfni kutmaydi: xizmat holatni har soniyada hisobot qilishi mumkin.
type Guard struct {
	b           Backend
	journalPath string

	opMu      sync.Mutex // Set/Start ketma-ketligi; quyidagi uchta maydon shu qulf bilan himoyalangan
	blocked   bool       // Block muvaffaqiyatli bo'lgan va undan keyin Unblock urinilmagan
	probed    bool       // Available javobi aniq (mavjud yoki edition) va keshlangan
	available bool       // probed bo'lsa: filtr mavjudmi

	stMu   sync.RWMutex
	state  string
	reason string
}

// NewGuard jurnalni journalPath'da saqlaydi. Katalogni yaratish va uning ACL'i (faqat SYSTEM va Administrators)
// xizmatning ishi: Guard katalog yaratmaydi (policy.NewPolicy va lock.FileStore kabi).
func NewGuard(b Backend, journalPath string) *Guard {
	return &Guard{b: b, journalPath: journalPath, state: StateOff}
}

// State oxirgi Set/Start natijasi. Boshida `off`.
func (g *Guard) State() string {
	g.stMu.RLock()
	defer g.stMu.RUnlock()
	return g.state
}

// Reason State `unavailable` (backend sababi, `edition`) yoki `failed` (xato matni) bo'lganda sababni qaytaradi,
// aks holda bo'sh. Faqat jurnalga yozish uchun: hubga yuborilmaydi.
func (g *Guard) Reason() string {
	g.stMu.RLock()
	defer g.stMu.RUnlock()
	return g.reason
}

func (g *Guard) set(state, reason string) string {
	g.stMu.Lock()
	defer g.stMu.Unlock()
	g.state, g.reason = state, reason
	return state
}

// Start helper ishga tushganda, birinchi Set'dan oldin, bir marta chaqiriladi: jurnal qolgan bo'lsa (oldingi ish
// bloklash paytida qulagan yoki kompyuter o'chgan), filtr o'chiriladi. Jurnal yo'q bo'lsa hech narsa qilmaydi
// (PowerShell ishga tushmaydi, holat `off`). Unblock yiqilsa jurnal qoladi, holat `failed` (sabab Reason'da);
// keyingi Set(false) qayta urinadi. Bu jarayonda allaqachon bloklangan bo'lsa (Set(true) muvaffaqiyatli bo'lgan)
// qoldiq emas: tegilmaydi.
func (g *Guard) Start(ctx context.Context) {
	g.opMu.Lock()
	defer g.opMu.Unlock()
	if g.blocked || !g.journalPending() {
		return
	}
	g.unblock(ctx)
}

// Set bloklash holatini filtrga qo'llaydi va natijaviy holatni qaytaradi: `blocked`, `unavailable`, `failed` yoki
// `off`. Takroriy chaqiruv xavfsiz: allaqachon bloklangan bo'lsa Set(true), qaytariladigan narsa yo'q bo'lsa
// Set(false) backend'ga (PowerShell) tegmaydi. `failed` esa har chaqiruvda qayta uriniladi, shuning uchun
// chaqiruvchi uni o'zgarishda yoki siyrak oraliqda chaqirishi kerak (har soniya emas).
//
// Set(false) hech qachon Available'ni so'ramaydi: filtr yoqilmagan bo'lsa, ochish tez va PowerShell'siz.
func (g *Guard) Set(ctx context.Context, locked bool) string {
	g.opMu.Lock()
	defer g.opMu.Unlock()
	if locked {
		return g.block(ctx)
	}
	return g.unblock(ctx)
}

func (g *Guard) block(ctx context.Context) string {
	if g.blocked {
		return g.set(StateBlocked, "")
	}
	if state, reason := g.probe(); state != "" {
		return g.set(state, reason)
	}
	// Jurnal Block'dan oldin: Block o'rtasida (yoki undan keyin) qulasa, qoldiq topiladi. Jurnal yozilmasa
	// bloklanmaydi: qulagan helper filtrni abadiy yoqilgan qoldirardi.
	if err := g.writeJournal(); err != nil {
		return g.set(StateFailed, fmt.Sprintf("jurnal yozilmadi: %v", err))
	}
	// Block yiqilsa ham jurnal qoladi: filtr qisman yoqilgan bo'lishi mumkin, Set(false) yoki Start uni o'chiradi.
	if err := g.b.Block(ctx); err != nil {
		return g.set(StateFailed, fmt.Sprintf("Keyboard Filter yoqilmadi: %v", err))
	}
	g.blocked = true
	return g.set(StateBlocked, "")
}

func (g *Guard) unblock(ctx context.Context) string {
	if !g.blocked && !g.journalPending() {
		if g.probed && !g.available {
			return g.set(StateUnavailable, ReasonEdition)
		}
		return g.set(StateOff, "")
	}
	// Unblock yiqilsa ham filtr qisman o'chgan bo'lishi mumkin: "bloklangan" belgisi tushiriladi, keyingi
	// Set(true) filtrni to'liq qayta yoqadi; jurnal esa qoldiqni eslab turadi.
	g.blocked = false
	if err := g.b.Unblock(ctx); err != nil {
		return g.set(StateFailed, fmt.Sprintf("Keyboard Filter o'chirilmadi: %v", err))
	}
	if err := g.removeJournal(); err != nil {
		// Filtr o'chdi, lekin jurnal hali "blocked" deydi: keyingi Start/Set(false) ortiqcha, zararsiz Unblock qiladi.
		return g.set(StateFailed, err.Error())
	}
	return g.set(StateOff, "")
}

// probe Backend mavjudligini aniqlaydi. state bo'sh bo'lsa filtr mavjud. Aniq javob (mavjud yoki edition)
// keshlanadi; probe xatosi keshlanmaydi: keyingi Set(true) qayta so'raydi (masalan, WMI hali tayyor emas).
func (g *Guard) probe() (state, reason string) {
	if !g.probed {
		ok, why := g.b.Available()
		switch {
		case ok:
			g.probed, g.available = true, true
		case why == ReasonEdition:
			g.probed, g.available = true, false
		default:
			if why == "" {
				why = "Keyboard Filter mavjudligi aniqlanmadi"
			}
			return StateFailed, why
		}
	}
	if !g.available {
		return StateUnavailable, ReasonEdition
	}
	return "", ""
}

// journalPending jurnal fayli borligini bildiradi: u faqat Block'dan oldin yoziladi va faqat muvaffaqiyatli
// Unblock'dan keyin o'chiriladi, ya'ni mavjud jurnal filtr yoqilgan bo'lishi mumkinligini bildiradi. Mazmuni
// o'qilmaydi: fayl buzilgan yoki o'qib bo'lmaydigan bo'lsa ham "bloklash yo'q" deb o'ylamaymiz (policy.Pending kabi).
func (g *Guard) journalPending() bool {
	_, err := os.Stat(g.journalPath)
	return !errors.Is(err, os.ErrNotExist)
}

// writeJournal jurnalni atomik yozadi: shu katalogdagi vaqtinchalik faylga yozib, fsync qilib, nishon ustiga rename
// qiladi (yarim yozilgan jurnal hech qachon ko'rinmaydi).
func (g *Guard) writeJournal() (err error) {
	data, err := json.Marshal(journal{State: journalBlocked})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(g.journalPath), ".cad-*.tmp")
	if err != nil {
		return fmt.Errorf("cad-journal.json vaqtinchalik fayli ochilmadi: %w", err)
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
	if err = os.Rename(tmp.Name(), g.journalPath); err != nil {
		return fmt.Errorf("cad-journal.json almashtirilmadi: %w", err)
	}
	return nil
}

func (g *Guard) removeJournal() error {
	if err := os.Remove(g.journalPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cad-journal.json o'chirilmadi: %w", err)
	}
	return nil
}
