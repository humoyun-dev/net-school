// Package install helper'ni himoyalangan Windows xizmati sifatida o'rnatadi va olib tashlaydi
// (install_windows.go). Bu faylda toza, har OS'da test qilinadigan qismlar.
package install

import (
	"encoding/json"

	"github.com/humoyun-dev/net-school/native/helper/internal/service"
)

// DisplayName xizmatning ko'rinadigan nomi (Global Constraints).
const DisplayName = "NetSchool Helper"

// Description services.msc'dagi tavsif.
const Description = "NetSchool: sinfni bloklash va OS siyosati (SYSTEM)"

// ServiceSDDL xizmat DACL'i (Global Constraints). SYSTEM boshqaradi, Administrators hammasini qiladi, interaktiv
// (IU) va xizmat (SU) foydalanuvchilari faqat holatni so'raydi: RP (start), WP (stop), DT (pause), SD (delete),
// WD/WO (DACL/egani o'zgartirish) yo'q.
const ServiceSDDL = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"

// RecoveryDelaysMs xizmat qulasa qayta ishga tushirish kechikishlari: 1 s, 1 s, 5 s (keyingilari ham 5 s).
var RecoveryDelaysMs = []int{1000, 1000, 5000}

// RecoveryResetSeconds xato hisoblagichi shuncha vaqtdan keyin nollanadi.
const RecoveryResetSeconds = 86400

// RunKey va RunValue P0c paketi `enroll.cmd` yozgan HKLM autostart'i. Endi Companion'ni xizmat ishga tushiradi va
// kuzatadi, shuning uchun install uni o'chiradi (aks holda ikki Companion bo'lardi).
const (
	RunKey   = `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
	RunValue = "NetSchool Companion"
)

// Chiqish kodlari (cmd/netschool-helper): 0 muvaffaqiyat, 1 xato, 2 noto'g'ri foydalanish, 5 administrator emas.
const (
	ExitOK       = 0
	ExitFailed   = 1
	ExitUsage    = 2
	ExitNotAdmin = 5
)

// HelperDeviceJSON Companion `enroll` yozgan device.json'dan helper'ga kerakli maydonlarni (hubOrigin, deviceId)
// ajratadi. Qolganlari (siteId, publicKey, ...) Companion'niki va helper katalogiga yozilmaydi.
func HelperDeviceJSON(raw []byte) ([]byte, error) {
	cfg, err := service.ParseDeviceConfig(raw)
	if err != nil {
		return nil, err
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}
