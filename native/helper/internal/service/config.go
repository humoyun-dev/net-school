package service

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sync"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
	"github.com/humoyun-dev/net-school/native/helper/internal/lock"
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

// ErrUntrustedConfigDir helper katalogi himoyalanmadi yoki tekshiruvdan o'tmadi (egasi Administrators/SYSTEM va
// himoyalangan DACL emas). Bunday katalogdagi device.json, hub-ca.pem, helper.key va lock.json'ga ishonilmaydi:
// xizmat hub'siz va ochiq holatda ishlaydi, DirGate esa VerifyRetry oralig'ida qayta uradi.
var ErrUntrustedConfigDir = errors.New("helper katalogi tekshiruvdan o'tmadi: konfiguratsiya o'qilmaydi")

// VerifyRetry tekshirilmagan helper katalogini qayta himoyalash va tekshirish oralig'i.
const VerifyRetry = 60 * time.Second

// DirGate helper katalogi tekshirilganmi. verify (himoyalash + tekshiruv) birinchi so'rovda, keyin tekshirilmaguncha
// VerifyRetry'dan tez bo'lmagan oraliqda chaqiriladi; bir marta o'tgach qayta chaqirilmaydi. Bir nechta
// goroutine'dan xavfsiz (verify mutex ostida: parallel hardening bo'lmaydi).
type DirGate struct {
	verify func() bool
	clock  Clock

	mu    sync.Mutex
	ok    bool
	tried bool
	next  time.Duration
}

func NewDirGate(verify func() bool, clock Clock) *DirGate {
	return &DirGate{verify: verify, clock: clock}
}

// Verified katalog tekshirilgan bo'lsa true; muddati kelgan bo'lsa qayta urinadi.
func (g *DirGate) Verified() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ok {
		return true
	}
	now := g.clock.Uptime()
	if g.tried && now < g.next {
		return false
	}
	g.tried, g.next = true, now+VerifyRetry
	g.ok = g.verify()
	return g.ok
}

// GatedLoad katalog tekshirilmaguncha load'ni chaqirmaydi (ErrUntrustedConfigDir).
func GatedLoad(g *DirGate, load func() (Hub, error)) func() (Hub, error) {
	return func() (Hub, error) {
		if !g.Verified() {
			return nil, ErrUntrustedConfigDir
		}
		return load()
	}
}

// GatedStore lock.json'ni faqat tekshirilgan katalogda o'qiydi va yozadi. Tekshirilmagan bo'lsa Load "yo'q" deydi
// (xizmat ochiq holatdan boshlaydi), Save/Clear esa ErrUntrustedConfigDir qaytaradi.
func GatedStore(g *DirGate, inner lock.Store) lock.Store { return gatedStore{g: g, inner: inner} }

type gatedStore struct {
	g     *DirGate
	inner lock.Store
}

func (s gatedStore) Load() (lock.Saved, bool, error) {
	if !s.g.Verified() {
		return lock.Saved{}, false, nil
	}
	return s.inner.Load()
}

func (s gatedStore) Save(v lock.Saved) error {
	if !s.g.Verified() {
		return ErrUntrustedConfigDir
	}
	return s.inner.Save(v)
}

func (s gatedStore) Clear() error {
	if !s.g.Verified() {
		return ErrUntrustedConfigDir
	}
	return s.inner.Clear()
}
