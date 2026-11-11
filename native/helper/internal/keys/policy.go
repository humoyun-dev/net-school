// Package keys Windows'ning past darajadagi klaviatura hook'i uchun tugma bloklash qoidalarini saqlaydi.
//
// Qoidalar Companion'dagi apps/companion/src/core/key-policy.ts bilan bir xil (ADR 0012, 2-qaror) va u bilan
// packages/contracts/fixtures/key-policy.json vektorlari orqali bog'langan: ikkala test shu faylni o'qiydi.
// Bu paket toza mantiq: Windows API va build tag yo'q, har OS'da test qilinadi (Windows hook callback'i keyingi vazifada chaqiradi).
package keys

// Windows virtual-key kodlari (WinUser.h).
const (
	vkTab      = 0x09
	vkControl  = 0x11
	vkMenu     = 0x12 // Alt
	vkEscape   = 0x1b
	vkSpace    = 0x20
	vkLWin     = 0x5b
	vkRWin     = 0x5c
	vkLControl = 0xa2
	vkRControl = 0xa3
	vkLMenu    = 0xa4
	vkRMenu    = 0xa5
	vkF4       = 0x73
)

// KBDLLHOOKSTRUCT.flags bitlari.
const (
	LLKHFInjected = 0x10
	LLKHFAltDown  = 0x20
)

// Event hook'ga kelgan bitta tugma hodisasi (WH_KEYBOARD_LL).
type Event struct {
	VK    uint32 // KBDLLHOOKSTRUCT.vkCode
	Flags uint32 // KBDLLHOOKSTRUCT.flags
	Down  bool   // WM_KEYDOWN/WM_SYSKEYDOWN true, WM_KEYUP/WM_SYSKEYUP false
}

// held bitlari: faqat Ctrl va Alt tugmalari kuzatiladi, har biri alohida (bittasi qo'yib yuborilsa boshqasi qoladi).
const (
	heldControl uint8 = 1 << iota
	heldLControl
	heldRControl
	heldMenu
	heldLMenu
	heldRMenu

	heldCtrlMask = heldControl | heldLControl | heldRControl
	heldAltMask  = heldMenu | heldLMenu | heldRMenu
)

// swallowed bitlari: faqat to'silishi mumkin bo'lgan oltita tugma (Win, Tab, Esc, F4, Space).
const (
	swallowLWin uint8 = 1 << iota
	swallowRWin
	swallowTab
	swallowEscape
	swallowF4
	swallowSpace
)

func heldBit(vk uint32) uint8 {
	switch vk {
	case vkControl:
		return heldControl
	case vkLControl:
		return heldLControl
	case vkRControl:
		return heldRControl
	case vkMenu:
		return heldMenu
	case vkLMenu:
		return heldLMenu
	case vkRMenu:
		return heldRMenu
	}
	return 0
}

func swallowBit(vk uint32) uint8 {
	switch vk {
	case vkLWin:
		return swallowLWin
	case vkRWin:
		return swallowRWin
	case vkTab:
		return swallowTab
	case vkEscape:
		return swallowEscape
	case vkF4:
		return swallowF4
	case vkSpace:
		return swallowSpace
	}
	return 0
}

// Policy hodisalar ketma-ketligini kuzatadi: Ctrl/Alt holati va to'silgan tugmaning "up"i
// (aks holda Win'ning "up"i Start'ni ochadi).
//
// TS versiyasi tugma kodlarini Set'da saqlaydi, lekin qoidalar faqat Ctrl/Alt tugmalarining holatini va
// to'silishi mumkin bo'lgan oltita tugmaning "swallowed" holatini so'raydi; shuning uchun ikkita bitmaska
// xatti-harakatni aynan saqlaydi va Handle xotira ajratmaydi (hook callback'i tez bo'lishi shart).
//
// Policy goroutine-xavfsiz EMAS: hook callback'i ishlaydigan bitta OS thread'idan foydalaning (TS tomoni ham bitta oqimli).
// Nol qiymat ishlatishga tayyor.
type Policy struct {
	held      uint8
	swallowed uint8
}

// Handle hodisani qayta ishlaydi va uni to'sish kerakmi (true) yoki keyingi hook'ga o'tkazish kerakmi (false) qaytaradi.
func (p *Policy) Handle(e Event) (block bool) {
	// Dasturiy yuborilgan kiritish (MeshAgent orqali o'qituvchining masofaviy boshqaruvi) hech qachon to'silmaydi
	// va modifier holatiga ta'sir qilmaydi.
	if e.Flags&LLKHFInjected != 0 {
		return false
	}

	if !e.Down {
		p.held &^= heldBit(e.VK)
		if bit := swallowBit(e.VK); p.swallowed&bit != 0 {
			p.swallowed &^= bit
			return true
		}
		return false
	}

	p.held |= heldBit(e.VK)
	if p.isBlocked(e) {
		p.swallowed |= swallowBit(e.VK)
		return true
	}
	return false
}

// Reset bloklash tugaganda yoki hook qayta o'rnatilganda eski holat qolmasligi uchun.
func (p *Policy) Reset() {
	p.held = 0
	p.swallowed = 0
}

func (p *Policy) isBlocked(e Event) bool {
	switch e.VK {
	case vkLWin, vkRWin:
		return true
	}
	alt := p.held&heldAltMask != 0 || e.Flags&LLKHFAltDown != 0
	ctrl := p.held&heldCtrlMask != 0
	if alt {
		switch e.VK {
		case vkTab, vkEscape, vkF4, vkSpace:
			return true
		}
	}
	// Ctrl+Esc (Start) va Ctrl+Shift+Esc (Vazifalar menejeri): Shift natijaga ta'sir qilmaydi, ikkalasi ham to'siladi.
	return ctrl && e.VK == vkEscape
}
