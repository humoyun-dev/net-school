package nativehost

import (
	"errors"
	"fmt"

	"github.com/humoyun-dev/net-school/native/helper/internal/procguard"
)

// ServerTrusted Companion pipe'ining server jarayoni haqiqiy, Helper ishga tushirgan Companion'mi: image o'rnatilgan
// Companion exe'si va ota PID'i ishlayotgan NetSchoolHelper xizmatiniki. Faqat image tekshiruvi yetmaydi: o'quvchi
// o'sha exe'ni (RunAsNode) o'z skripti bilan ishga tushirib pipe nomini oldinroq egallashi mumkin — uning otasi
// explorer bo'ladi. PID qayta berilishi: Toolhelp'dagi ParentPID eski (o'lgan) otaga ishora qilishi mumkin, xizmat esa
// keyin shu PID'ni olgan bo'lishi mumkin — shuning uchun xizmat serverdan oldin yaratilgan bo'lishi shart (procguard
// trustedParent bilan bir xil qoida). Server host bilan bir sessiyada bo'lishi kerak.
func ServerTrusted(procs map[uint32]procguard.Proc, serverPID, servicePID, hostSession uint32, companionExe string) error {
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
	if server.Session != hostSession {
		return errors.New("pipe server boshqa sessiyada")
	}
	service, ok := procs[servicePID]
	if !ok || service.Stale || service.Created.IsZero() || server.Created.IsZero() {
		return errors.New("NetSchoolHelper yoki server yaratilish vaqti o'qilmadi")
	}
	if service.Created.After(server.Created) {
		return errors.New("pipe server NetSchoolHelper'dan oldin yaratilgan (PID qayta berilgan)")
	}
	return nil
}
