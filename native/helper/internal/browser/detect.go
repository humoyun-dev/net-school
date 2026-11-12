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

// managedImages siyosat qo'llanadigan brauzerlar — faqat o'rnatilgan joydan (trustedDirs) ishlasa. Boshqa joydagi
// chrome.exe (masalan portable Chromium, u Google Chrome siyosatlarini o'qimaydi) boshqarilmaydigan hisoblanadi.
var managedImages = map[string]bool{"chrome.exe": true, "msedge.exe": true}

// Unmanaged image yo'llaridan boshqarilmaydigan brauzer nomlari (takrorsiz, saralangan). Nom bo'yicha aniqlash:
// boshqa nomga o'zgartirilgan brauzerni P2c ko'rmaydi (qoldiq risk, P2h ilova allowlist'i yopadi).
func Unmanaged(trustedDirs []string, images []string) []string {
	seen := map[string]bool{}
	for _, img := range images {
		lower := strings.ToLower(img)
		base := filepath.Base(strings.ReplaceAll(lower, `\`, "/"))
		if unmanagedImages[base] || (managedImages[base] && !under(lower, trustedDirs)) {
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

func under(path string, dirs []string) bool {
	for _, d := range dirs {
		d = strings.TrimRight(strings.ToLower(d), `\`) + `\`
		if strings.HasPrefix(path, d) {
			return true
		}
	}
	return false
}
