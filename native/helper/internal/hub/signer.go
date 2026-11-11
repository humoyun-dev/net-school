// Package hub helper'ning hub bilan aloqasi: so'rov imzosi (signer.go) va imzolangan HTTPS mijoz (client.go).
package hub

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// ClockSkewTolerance: hub javobidagi `Date` (soniya aniqligida) bilan qurilma soati shundan ko'p farq qilsa,
// imzo soati tuzatiladi. Companion'dagi CLOCK_SKEW_TOLERANCE_MS (apps/companion/src/core/identity.ts) bilan bir xil.
const ClockSkewTolerance = 5 * time.Second

// Signer har so'rovni qurilma kaliti bilan imzolaydi. Format Companion bilan bir xil
// (identity.ts `RequestSigner`): `NSDEV1\n{method}\n{pathWithQuery}\n{timestamp}\n{sha256hex(body)}`,
// Ed25519, base64url (padding'siz). Imzo `x-ns-signer` qiymatini qamrab olmaydi.
// Bir nechta goroutine'dan xavfsiz chaqiriladi.
type Signer struct {
	deviceID string
	key      ed25519.PrivateKey
	signer   string
	now      func() time.Time

	mu       sync.Mutex
	offsetMs int64 // hub vaqtiga moslash: qurilma soatiga qo'shiladi
	lastMs   int64 // oxirgi imzolangan timestamp
}

// NewSigner `signer` qiymatini (helper uchun "helper") har so'rovga `x-ns-signer` sarlavhasi qilib qo'shadi.
func NewSigner(deviceID string, key ed25519.PrivateKey, signer string, now func() time.Time) *Signer {
	return &Signer{deviceID: deviceID, key: key, signer: signer, now: now}
}

// signingInput hub'dagi `deviceSigningInput` bilan bir xil bayt ketma-ketligi.
func signingInput(method, pathWithQuery, timestamp string, body []byte) []byte {
	sum := sha256.Sum256(body)
	return []byte("NSDEV1\n" + method + "\n" + pathWithQuery + "\n" + timestamp + "\n" + hex.EncodeToString(sum[:]))
}

// Sign `x-ns-device-id`, `x-ns-timestamp`, `x-ns-signature` va `x-ns-signer` sarlavhalarini qaytaradi.
// Hub `ts > last_signed_ts` talab qiladi, shuning uchun timestamp qat'iy o'sadi (bir millisekundda ikki marta
// chaqirilsa ham). Sarlavha nomlari `http.Header.Set` bilan kanonik shaklga keltiriladi; HTTP'da registr ahamiyatsiz.
func (s *Signer) Sign(method, pathWithQuery string, body []byte) http.Header {
	s.mu.Lock()
	ts := max(s.now().UnixMilli()+s.offsetMs, s.lastMs+1)
	s.lastMs = ts
	s.mu.Unlock()

	timestamp := strconv.FormatInt(ts, 10)
	signature := ed25519.Sign(s.key, signingInput(method, pathWithQuery, timestamp, body))

	h := http.Header{}
	h.Set("x-ns-device-id", s.deviceID)
	h.Set("x-ns-timestamp", timestamp)
	h.Set("x-ns-signature", base64.RawURLEncoding.EncodeToString(signature))
	h.Set("x-ns-signer", s.signer)
	return h
}

// SyncClock hub vaqtiga moslaydi: farq 5 s dan oshsa offset shunga o'rnatiladi, aks holda nolga qaytadi
// (qurilma soati to'g'rilangan bo'lsa eski offset qolib ketmasin).
// Offset o'zgarsa oxirgi timestamp ham tuzatilgan soatga tortiladi: oldinda ketgan soat bilan yozilgan
// kelajakdagi timestamp'larni hub qabul qilmagan (oynadan tashqarida), aks holda keyingi imzolar ham o'sha
// kelajakdan davom etib rad etilardi. `identity.ts` `syncClock` bilan bir xil.
func (s *Signer) SyncClock(hubTime time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	nowMs := s.now().UnixMilli()
	skew := hubTime.UnixMilli() - nowMs
	var offset int64
	if abs(skew) > ClockSkewTolerance.Milliseconds() {
		offset = skew
	}
	if offset == s.offsetMs {
		return
	}
	s.offsetMs = offset
	s.lastMs = min(s.lastMs, nowMs+offset-1)
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// LoadKey `helper.key` faylidan Ed25519 PKCS#8 PEM kalitni o'qiydi (Companion `generateDeviceKey` formati).
func LoadKey(pemPath string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(pemPath)
	if err != nil {
		return nil, fmt.Errorf("helper kalitini o'qib bo'lmadi: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, errors.New("helper kaliti PEM emas")
	}
	if block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("helper kaliti PKCS#8 private key emas (PEM turi %q)", block.Type)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("helper kaliti PKCS#8 sifatida o'qilmadi: %w", err)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("helper kaliti Ed25519 emas (%T)", parsed)
	}
	return key, nil
}
