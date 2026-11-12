package browser

import (
	"path/filepath"
	"sort"
	"strings"
)

// unmanagedImages — NetSchool siyosati qo'llanmaydigan brauzerlar (P2c: faqat aniqlanadi, bloklash P2h'da).
var unmanagedImages = map[string]bool{
	"firefox.exe":  true,
	"browser.exe":  true, // Yandex Browser
	"opera.exe":    true,
	"brave.exe":    true,
	"vivaldi.exe":  true,
	"chromium.exe": true,
	"iexplore.exe": true,
}

// Unmanaged image yo'llaridan boshqarilmaydigan brauzer nomlari (takrorsiz, saralangan).
func Unmanaged(images []string) []string {
	seen := map[string]bool{}
	for _, img := range images {
		base := strings.ToLower(filepath.Base(strings.ReplaceAll(img, `\`, "/")))
		if unmanagedImages[base] {
			seen[base] = true
		}
	}
	out := make([]string, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
