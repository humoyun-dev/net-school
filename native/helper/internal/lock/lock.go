// Package lock bloklash lease holat mashinasi: hub holatini qabul qiladi, lease'ni monoton uptime bilan hisoblaydi.
// Toza mantiq: hech qanday OS yoki tarmoq kodi yo'q, soat va saqlash tashqaridan beriladi.
package lock

import (
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
)

const (
	// DefaultLease hub `leaseSeconds` bermasa (musbat emas) ishlatiladi (hub OVERLAY_LEASE_MS = 120 s).
	DefaultLease = 120 * time.Second
	// MaxLease lease'ning yuqori chegarasi: hub xatosi yoki buzilgan fayl lock'ni deyarli abadiy qilib qo'ymasin
	// (va Duration to'lib ketmasin). Hub amalda 120 s beradi.
	MaxLease = time.Hour
)

// Clock vaqt manbai. Lease faqat Uptime bilan o'lchanadi (devor soatini o'zgartirib lease'ni cho'zib bo'lmaydi);
// BootID boshqa boot'dagi saqlangan holatni tanish uchun.
type Clock interface {
	Now() time.Time
	Uptime() time.Duration
	BootID() string
}

// Lock bloklash holati. Bir nechta goroutine'dan xavfsiz (hub so'rovi Apply, taymer Tick, xizmat Locked chaqiradi).
//
// Qoidalar (Companion `OverlayController` semantikasi, ADR 0009):
//   - hub holati faqat teng yoki yangiroq `sequence` bilan qo'llanadi, eskirgani hech narsani, jumladan lease'ni
//     ham o'zgartirmaydi; `sequence` son sifatida solishtiriladi ("9" < "10");
//   - `locked` holat lease (hub `leaseSeconds`) qadar turadi va har tasdiqlanishda uzayadi; hub yo'qolsa lease
//     tugagach Tick uni tushiradi (o'quvchi abadiy bloklanib qolmaydi). Sequence saqlanadi: hub qaytgach
//     bir xil lock qayta qo'llanadi;
//   - `locked:false` va `sequence:null` — dars yo'q: darhol ochiladi va sequence unutiladi.
type Lock struct {
	clock Clock
	store Store

	mu       sync.Mutex
	locked   bool
	hasSeq   bool
	seq      uint64
	deadline time.Duration // uptime
	storeErr error
}

func New(clock Clock, store Store) *Lock {
	return &Lock{clock: clock, store: store}
}

// Locked hozir bloklanganmi.
func (l *Lock) Locked() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.locked
}

// StoreErr eng oxirgi saqlash amalining xatosi (muvaffaqiyatli amaldan keyin nil). Saqlash xatosi lock'ni
// qo'llashga to'sqinlik qilmaydi (faqat qayta ishga tushganda tiklashni yo'qotadi), shuning uchun u jimgina
// emas, xizmat jurnaliga yozishi uchun ko'rinadi.
func (l *Lock) StoreErr() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.storeErr
}

// Apply hub holatini qo'llaydi. Noto'g'ri `sequence` (uint64 emas) — noma'lum holat, e'tiborsiz qoldiriladi.
func (l *Lock) Apply(s hub.LockState) {
	l.mu.Lock()
	defer l.mu.Unlock()

	var seq uint64
	hasSeq := s.Sequence != nil
	if hasSeq {
		v, err := strconv.ParseUint(*s.Sequence, 10, 64)
		if err != nil {
			return
		}
		seq = v
	}

	if !s.Locked && !hasSeq {
		// Dars yo'q (yoki qurilma darsda emas): darhol ochiladi, sequence ham unutiladi.
		l.hasSeq, l.seq = false, 0
		l.release()
		return
	}
	// Eskirgan holat. Sequence'siz holat har qanday raqamlidan eski.
	if l.hasSeq && (!hasSeq || seq < l.seq) {
		return
	}
	l.hasSeq, l.seq = hasSeq, seq
	if !s.Locked {
		l.release()
		return
	}

	lease := time.Duration(s.LeaseSeconds) * time.Second
	if s.LeaseSeconds <= 0 {
		lease = DefaultLease
	}
	lease = min(lease, MaxLease)
	l.locked = true
	l.deadline = l.clock.Uptime() + lease
	var saved *uint64
	if l.hasSeq {
		seqCopy := l.seq // store ichki holatga ishora saqlab qolmasin
		saved = &seqCopy
	}
	l.storeErr = l.store.Save(Saved{BootID: l.clock.BootID(), Sequence: saved, DeadlineUptimeMs: l.deadline.Milliseconds()})
}

// Tick lease tugagan lock'ni tushiradi (uptime >= deadline). Xizmat buni muntazam (masalan har soniya) chaqiradi.
func (l *Lock) Tick() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.locked && l.clock.Uptime() >= l.deadline {
		l.release()
	}
}

// Restore ishga tushganda saqlangan lock'ni tiklaydi: faqat shu boot'da va lease tugamagan bo'lsa.
// Aks holda (boshqa boot, tugagan lease, o'qib bo'lmaydigan fayl) saqlangan holat o'chiriladi va ochiq holatdan
// boshlanadi. Tiklangan sequence keyingi hub holatlarini filtrlaydi.
func (l *Lock) Restore() {
	l.mu.Lock()
	defer l.mu.Unlock()

	saved, ok, err := l.store.Load()
	if err != nil {
		l.storeErr = errors.Join(err, l.store.Clear())
		return
	}
	if !ok {
		return
	}
	uptimeMs := l.clock.Uptime().Milliseconds()
	remainingMs := saved.DeadlineUptimeMs - uptimeMs
	if saved.BootID != l.clock.BootID() || remainingMs <= 0 || remainingMs > MaxLease.Milliseconds() {
		l.storeErr = l.store.Clear()
		return
	}
	l.locked = true
	l.hasSeq = saved.Sequence != nil
	l.seq = 0
	if l.hasSeq {
		l.seq = *saved.Sequence
	}
	l.deadline = time.Duration(saved.DeadlineUptimeMs) * time.Millisecond
}

// release lock'ni tushiradi va saqlangan holatni o'chiradi (faqat bloklangan edi).
func (l *Lock) release() {
	if !l.locked {
		return
	}
	l.locked = false
	l.deadline = 0
	l.storeErr = l.store.Clear()
}
