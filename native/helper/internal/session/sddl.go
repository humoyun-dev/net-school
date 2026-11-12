package session

import (
	"fmt"
	"regexp"
)

// O'quvchi sessiyasida helper ishga tushiradigan jarayonlarning (Companion, guard) xavfsizlik deskriptori
// (CreateProcessAsUser lpProcessAttributes/lpThreadAttributes). Standart DACL'da token egasi (o'quvchi) o'z
// jarayonini to'liq boshqaradi: Stop-Process sikli bilan Companion'ni (overlay'ni) tushirib turishi, to'xtatib
// qo'yishi, xotirasiga yozishi yoki uni ota-ona qilib (PROC_THREAD_ATTRIBUTE_PARENT_PROCESS) yangi jarayon ochishi
// mumkin edi. Bu yerda:
//   - SYSTEM va Administrators — to'liq huquq;
//   - o'quvchi (va OWNER RIGHTS, S-1-3-4) — faqat SYNCHRONIZE, READ_CONTROL va *_QUERY_LIMITED_INFORMATION.
//     OWNER RIGHTS ACE bo'lgani uchun egasining yashirin READ_CONTROL/WRITE_DAC huquqi bekor: o'quvchi DACL'ni
//     qayta yoza olmaydi.
//
// Cheklov: Companion keyin o'zi yaratadigan jarayon va iplarga (Electron renderer, GPU, ish iplari) token'ning
// standart DACL'i qo'llanadi, ularni o'quvchi to'xtata oladi (ADR 0014, 3-band).

const (
	// processAllAccess / threadAllAccess — PROCESS_ALL_ACCESS / THREAD_ALL_ACCESS.
	processAllAccess = 0x1fffff
	threadAllAccess  = 0x1fffff
	// userProcessAccess = SYNCHRONIZE | READ_CONTROL | PROCESS_QUERY_LIMITED_INFORMATION.
	userProcessAccess = 0x00100000 | 0x00020000 | 0x1000
	// userThreadAccess = SYNCHRONIZE | READ_CONTROL | THREAD_QUERY_LIMITED_INFORMATION.
	userThreadAccess = 0x00100000 | 0x00020000 | 0x0800
)

var sidPattern = regexp.MustCompile(`^S-1-[0-9]+(-[0-9]+)+$`)

// ProcessSDDL jarayon obyektining SDDL'i. userSID bo'sh bo'lsa (SYSTEM jarayoni — guard) foydalanuvchi ACE'si yo'q.
func ProcessSDDL(userSID string) (string, error) {
	return sddl(processAllAccess, userProcessAccess, userSID)
}

// ThreadSDDL birinchi ipning SDDL'i (Electron'da u UI ipi, overlay oynalari unga tegishli).
func ThreadSDDL(userSID string) (string, error) {
	return sddl(threadAllAccess, userThreadAccess, userSID)
}

func sddl(all, limited uint32, userSID string) (string, error) {
	s := fmt.Sprintf("D:P(A;;%#x;;;SY)(A;;%#x;;;BA)(A;;%#x;;;OW)", all, all, limited)
	if userSID == "" {
		return s, nil
	}
	if !sidPattern.MatchString(userSID) {
		return "", fmt.Errorf("foydalanuvchi SID'i yaroqsiz: %q", userSID)
	}
	return s + fmt.Sprintf("(A;;%#x;;;%s)", limited, userSID), nil
}
