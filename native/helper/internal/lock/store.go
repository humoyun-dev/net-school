package lock

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Saved qayta ishga tushganda lock'ni tiklash uchun saqlanadigan holat (`lock.json`).
// Faqat lock saqlanadi: ochiq holatda fayl yo'q, shunda qayta ishga tushgach qulf o'zi paydo bo'lmaydi.
type Saved struct {
	// BootID tizim yuklanishi: boshqa boot'da saqlangan lock tiklanmaydi.
	BootID string `json:"bootId"`
	// Sequence hub bergan oxirgi tartib raqami (nil — hub raqam bermagan).
	Sequence *uint64 `json:"sequence"`
	// DeadlineUptimeMs lease tugaydigan payt, tizim uptime'ida (millisekund).
	DeadlineUptimeMs int64 `json:"deadlineUptimeMs"`
}

// Store lock holatini saqlaydi. Realizatsiya bir nechta goroutine'dan chaqirilmaydi (Lock o'zi ketma-ketlaydi).
type Store interface {
	// Load saqlangan holatni qaytaradi; fayl yo'q bo'lsa (Saved{}, false, nil).
	Load() (Saved, bool, error)
	Save(Saved) error
	// Clear saqlangan holatni o'chiradi; yo'q bo'lsa xato emas.
	Clear() error
}

// FileStore Store'ni bitta JSON faylda (`%ProgramData%\NetSchool\helper\lock.json`) saqlaydi.
// Katalogni yaratish va uning ACL'i (faqat SYSTEM va Administrators) xizmatning ishi: FileStore katalog yaratmaydi.
type FileStore struct {
	path string
}

func NewFileStore(path string) *FileStore { return &FileStore{path: path} }

// Load faylni qat'iy o'qiydi: noma'lum maydon, bo'sh BootID, manfiy deadline, ortiqcha ma'lumot — xato.
// Xato holatida chaqiruvchi (Lock.Restore) faylni o'chiradi va ochiq holatdan boshlaydi.
func (s *FileStore) Load() (Saved, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return Saved{}, false, nil
	}
	if err != nil {
		return Saved{}, false, fmt.Errorf("lock.json o'qilmadi: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var saved Saved
	if err := dec.Decode(&saved); err != nil {
		return Saved{}, false, fmt.Errorf("lock.json noto'g'ri: %w", err)
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Saved{}, false, errors.New("lock.json'da ortiqcha ma'lumot bor")
	}
	if saved.BootID == "" || saved.DeadlineUptimeMs < 0 {
		return Saved{}, false, errors.New("lock.json maydonlari yaroqsiz")
	}
	return saved, true, nil
}

// Save atomik yozadi: shu katalogdagi vaqtinchalik faylga yozib, fsync qilib, nishon ustiga rename qiladi.
// Yarim yozilgan lock.json hech qachon ko'rinmaydi.
func (s *FileStore) Save(v Saved) (err error) {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".lock-*.tmp")
	if err != nil {
		return fmt.Errorf("lock.json vaqtinchalik fayli ochilmadi: %w", err)
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), s.path); err != nil {
		return fmt.Errorf("lock.json almashtirilmadi: %w", err)
	}
	return nil
}

func (s *FileStore) Clear() error {
	if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("lock.json o'chirilmadi: %w", err)
	}
	return nil
}
