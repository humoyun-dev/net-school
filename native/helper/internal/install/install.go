// Package install helper'ni himoyalangan Windows xizmati sifatida o'rnatadi va olib tashlaydi
// (install_windows.go). Bu faylda toza, har OS'da test qilinadigan qismlar.
package install

import (
	"bytes"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
	"github.com/humoyun-dev/net-school/native/helper/internal/layout"
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

// MaxCABytes hub CA faylining eng katta hajmi (bir nechta sertifikatli zanjir ham sig'adi).
const MaxCABytes = 1 << 20

// ValidateHub `set-hub` argumentlarini tekshiradi va helper device.json'ini qaytaradi (faqat hubOrigin va
// deviceId: service.ParseDeviceConfig o'qiydigan format). origin faqat `https://host[:port]`. caPEM nil — CA yo'q
// (tizim root'lari); aks holda faqat CERTIFICATE bloklari, har biri x509 sifatida o'qiladi, ortiqcha matn yo'q.
func ValidateHub(origin, deviceID string, caPEM []byte) ([]byte, error) {
	if err := hub.CheckOrigin(origin); err != nil {
		return nil, err
	}
	raw, err := json.MarshalIndent(service.DeviceConfig{HubOrigin: origin, DeviceID: deviceID}, "", "  ")
	if err != nil {
		return nil, err
	}
	if _, err := service.ParseDeviceConfig(raw); err != nil {
		return nil, err
	}
	if caPEM != nil {
		if err := checkCA(caPEM); err != nil {
			return nil, err
		}
	}
	return append(raw, '\n'), nil
}

func checkCA(caPEM []byte) error {
	if len(caPEM) > MaxCABytes {
		return errors.New("hub CA fayli juda katta")
	}
	// Qat'iy: bloklar orasida va atrofida faqat bo'sh joy (pem.Decode BEGIN'dan oldingi matnni jimgina o'tkazib
	// yuboradi), sarlavhasiz CERTIFICATE bloklari. Companion enroll ham xuddi shu qoidani claim'dan oldin qo'llaydi
	// (apps/companion/src/core/helper.ts `checkCaPem`).
	rest, n := bytes.TrimSpace(caPEM), 0
	for len(rest) > 0 {
		if !bytes.HasPrefix(rest, []byte("-----BEGIN ")) {
			return errors.New("hub CA faylida sertifikatdan tashqari matn bor")
		}
		block, r := pem.Decode(rest)
		if block == nil {
			return errors.New("hub CA faylida buzilgan PEM bloki bor")
		}
		if block.Type != "CERTIFICATE" || len(block.Headers) != 0 {
			return fmt.Errorf("hub CA faylida %q bloki bor (faqat sarlavhasiz CERTIFICATE)", block.Type)
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return fmt.Errorf("hub CA sertifikati o'qilmadi: %w", err)
		}
		n++
		rest = bytes.TrimSpace(r)
	}
	if n == 0 {
		return errors.New("hub CA faylida sertifikat yo'q")
	}
	return nil
}

// ValidateToken enrollment tokeni: bo'sh emas, 512 belgigacha, faqat ko'rinadigan ASCII (proof satri
// `NSCLAIM1\n{token}\n...` yangi qator bilan buzilmasin).
func ValidateToken(token string) error {
	if token == "" || len(token) > 512 {
		return errors.New("token bo'sh yoki juda uzun")
	}
	for i := 0; i < len(token); i++ {
		if token[i] < 0x21 || token[i] > 0x7e {
			return errors.New("tokenda ruxsat etilmagan belgi bor")
		}
	}
	return nil
}

// HelperKeyResult `helper-key` stdout'i (enroll claim'ga qo'shadi).
type HelperKeyResult struct {
	HelperPublicKey string `json:"helperPublicKey"`
	HelperProof     string `json:"helperProof"`
	// DataRootReplaced `%ProgramData%\NetSchool` ishonchsiz edi va qayta yaratildi (fsacl.DataResult): enroll
	// ogohlantirish chiqaradi. Claim'ga yuborilmaydi.
	DataRootReplaced bool `json:"dataRootReplaced"`
}

// SkipInCompanionCopy paket katalogidan Companion katalogiga nusxalanmaydigan fayllar (rel — paket ildiziga
// nisbatan): ildizdagi `*.cmd` (ular paket katalogidan ishga tushiriladi; Program Files'da `%~dp0` noto'g'ri
// joyni ko'rsatardi) va helper exe'si (u helper katalogida).
func SkipInCompanionCopy(rel string) bool {
	if strings.ContainsAny(rel, `\/`) {
		return false
	}
	return strings.EqualFold(rel, layout.HelperExe) || strings.HasSuffix(strings.ToLower(rel), ".cmd")
}
