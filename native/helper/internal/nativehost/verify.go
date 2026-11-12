package nativehost

import (
	"errors"
	"fmt"

	"github.com/humoyun-dev/net-school/native/helper/internal/procguard"
)

// ServerTrusted Companion pipe'ining server jarayoni haqiqiy, Helper ishga tushirgan Companion'mi: image o'rnatilgan
// Companion exe'si va ota PID'i ishlayotgan NetSchoolHelper xizmatiniki. Faqat image tekshiruvi yetmaydi: o'quvchi
// o'sha exe'ni (RunAsNode) o'z skripti bilan ishga tushirib pipe nomini oldinroq egallashi mumkin — uning otasi
// explorer bo'ladi. Xizmat tirik ekan uning PID'i boshqa jarayonga berilmaydi.
func ServerTrusted(procs map[uint32]procguard.Proc, serverPID, servicePID uint32, companionExe string) error {
	if servicePID == 0 {
		return errors.New("NetSchoolHelper xizmati ishlamayapti")
	}
	server, ok := procs[serverPID]
	if !ok {
		return fmt.Errorf("pipe server jarayoni (%d) topilmadi", serverPID)
	}
	if server.Stale {
		return errors.New("pipe server jarayonining ota PID'i ishonchsiz")
	}
	if server.Image != procguard.Normalize(companionExe) {
		return fmt.Errorf("pipe server Companion emas: %s", server.Image)
	}
	if server.ParentPID != servicePID {
		return fmt.Errorf("pipe server'ni NetSchoolHelper ishga tushirmagan (ota %d)", server.ParentPID)
	}
	return nil
}
