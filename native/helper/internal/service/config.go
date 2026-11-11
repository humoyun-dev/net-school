package service

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sync"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

// DeviceConfig helper'ning hub konfiguratsiyasi: `%ProgramData%\NetSchool\helper\device.json`. Format Companion
// `enroll` yozadigan device.json bilan bir xil (apps/companion/src/core/machine-store.ts), helper undan faqat
// hubOrigin va deviceId'ni oladi. Helper uni faqat o'z katalogidan o'qiydi (Companion katalogiga oddiy foydalanuvchi
// fayl qo'sha oladi); u yerga `install` (Task 11) nusxa ko'chiradi.
type DeviceConfig struct {
	HubOrigin string `json:"hubOrigin"`
	DeviceID  string `json:"deviceId"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ParseDeviceConfig device.json'ni o'qiydi. Boshqa maydonlar (siteId, publicKey, ...) e'tiborsiz qoldiriladi:
// ular Companion'niki. hubOrigin'ning to'liq tekshiruvi hub.NewClient'da (faqat https://host[:port]).
func ParseDeviceConfig(raw []byte) (DeviceConfig, error) {
	var cfg DeviceConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return DeviceConfig{}, errors.New("device.json noto'g'ri: " + err.Error())
	}
	if cfg.HubOrigin == "" {
		return DeviceConfig{}, errors.New("device.json'da hubOrigin yo'q")
	}
	if !uuidPattern.MatchString(cfg.DeviceID) {
		return DeviceConfig{}, errors.New("device.json'da deviceId yaroqsiz")
	}
	return cfg, nil
}

// HubUnavailableError hub konfiguratsiyasi yuklanmadi (fayllar yo'q yoki yaroqsiz). Bu paytda xizmat ochiq
// holatda ishlaydi va hisobot yubora olmaydi.
type HubUnavailableError struct{ Err error }

func (e *HubUnavailableError) Error() string { return "hub konfiguratsiyasi yo'q: " + e.Err.Error() }
func (e *HubUnavailableError) Unwrap() error { return e.Err }

// HubLoadRetry hub konfiguratsiyasi yuklanmasa qayta urinish oralig'i.
const HubLoadRetry = 30 * time.Second

// lazyHub Hub'ni birinchi kerak bo'lganda yuklaydi (device.json, hub-ca.pem, helper.key). Yuklanmasa xato
// qaytaradi va HubLoadRetry'dan keyin qayta urinadi: xizmat konfiguratsiyasiz ham ishlayveradi (Companion,
// MeshAgent kuzatuvi, qoldiq tozalash), enroll'dan keyin esa qayta ishga tushirishsiz hub'ga ulanadi.
type lazyHub struct {
	load  func() (Hub, error)
	clock Clock

	mu      sync.Mutex
	h       Hub
	err     error
	nextTry time.Duration
	tried   bool
}

func NewLazyHub(load func() (Hub, error), clock Clock) Hub {
	return &lazyHub{load: load, clock: clock}
}

func (l *lazyHub) get() (Hub, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.h != nil {
		return l.h, nil
	}
	now := l.clock.Uptime()
	if l.tried && now < l.nextTry {
		return nil, l.err
	}
	l.tried, l.nextTry = true, now+HubLoadRetry
	h, err := l.load()
	if err != nil {
		l.err = &HubUnavailableError{Err: err}
		return nil, l.err
	}
	l.h = h
	return l.h, nil
}

func (l *lazyHub) LockState(ctx context.Context) (hub.LockState, error) {
	h, err := l.get()
	if err != nil {
		return hub.LockState{}, err
	}
	return h.LockState(ctx)
}

func (l *lazyHub) ReportStatus(ctx context.Context, s hub.Status) error {
	h, err := l.get()
	if err != nil {
		return err
	}
	return h.ReportStatus(ctx, s)
}
