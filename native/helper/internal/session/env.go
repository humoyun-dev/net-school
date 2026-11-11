package session

import (
	"slices"
	"strings"
	"unicode/utf16"
)

// Muhit bloki (CreateProcessAsUser lpEnvironment, CREATE_UNICODE_ENVIRONMENT): UTF-16 `NOM=QIYMAT` satrlari, har biri
// NUL bilan tugaydi, blok oxirida yana bitta NUL. Bu fayl toza mantiq, har OS'da test qilinadi.
//
// Nega filtr: CreateEnvironmentBlock foydalanuvchi tokeni bilan `HKCU\Environment`ni qo'shadi, unga o'quvchi `setx`
// bilan yoza oladi. Companion'ga o'tsa: `ELECTRON_RUN_AS_NODE=1` uni oddiy Node'ga aylantiradi (overlay yo'q),
// `NODE_OPTIONS=--require ...` kod yuklaydi, `NETSCHOOL_COMPANION_DIR`/`ProgramData` soxta enrollment'ga yo'naltiradi.

// EnvVar majburan qo'yiladigan o'zgaruvchi. Value bo'sh bo'lsa o'zgaruvchi umuman bo'lmaydi (foydalanuvchi qiymati
// ham olib tashlanadi).
type EnvVar struct{ Name, Value string }

// droppedPrefixes shu prefikslar bilan boshlanadigan nomlar (katta-kichik harfsiz) tashlanadi: Electron/Node/Chromium
// xatti-harakatini yoki Companion sozlamalarini o'zgartiradi.
var droppedPrefixes = []string{"ELECTRON_", "NODE_", "NETSCHOOL_", "NPM_CONFIG_", "CHROME_", "OPENSSL_"}

// droppedNames aniq nomlar: TLS kalitlarini faylga yozish va moslik shim'lari.
var droppedNames = []string{"SSLKEYLOGFILE", "__COMPAT_LAYER"}

// ParseEnvBlock blokni `NOM=QIYMAT` satrlariga ajratadi. Bo'sh satr (ikkinchi NUL) blok oxiri; oxirgi NUL'siz
// buzilgan blokning qolgani ham satr sifatida olinadi.
func ParseEnvBlock(b []uint16) []string {
	var out []string
	start := 0
	for i, c := range b {
		if c != 0 {
			continue
		}
		if i == start {
			return out
		}
		out = append(out, string(utf16.Decode(b[start:i])))
		start = i + 1
	}
	if start < len(b) {
		out = append(out, string(utf16.Decode(b[start:])))
	}
	return out
}

// SerializeEnvBlock satrlardan blok yasaydi (har satrdan keyin NUL, oxirida qo'shimcha NUL). Bo'sh ro'yxat — ikki NUL.
func SerializeEnvBlock(vars []string) []uint16 {
	var b []uint16
	for _, v := range vars {
		b = append(b, utf16.Encode([]rune(v))...)
		b = append(b, 0)
	}
	if len(vars) == 0 {
		b = append(b, 0)
	}
	return append(b, 0)
}

// envName satrning nomi. Windows'ning yashirin `=C:=C:\` satrlarida nom `=` bilan boshlanadi, shuning uchun `=`
// birinchi belgidan keyin qidiriladi. `=` yo'q satr — yaroqsiz ("", false).
func envName(v string) (string, bool) {
	if v == "" {
		return "", false
	}
	i := strings.IndexByte(v[1:], '=')
	if i < 0 {
		return "", false
	}
	return v[:i+1], true
}

func dropped(name string) bool {
	upper := strings.ToUpper(name)
	for _, p := range droppedPrefixes {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	return slices.Contains(droppedNames, upper)
}

// SanitizeEnv foydalanuvchi muhitidan Companion'ga xavfli o'zgaruvchilarni olib tashlaydi va forced'dagilarni
// (Known Folders, tizim Path) foydalanuvchi qiymati o'rniga qo'yadi. Natija nom bo'yicha katta-kichik harfsiz
// tartiblangan (CreateProcess hujjati bloki shunday bo'lishini talab qiladi), har nom bir marta.
func SanitizeEnv(vars []string, forced []EnvVar) []string {
	isForced := map[string]bool{}
	for _, f := range forced {
		isForced[strings.ToUpper(f.Name)] = true
	}
	seen := map[string]bool{}
	var out []string
	for _, v := range vars {
		name, ok := envName(v)
		if !ok || dropped(name) || isForced[strings.ToUpper(name)] || seen[strings.ToUpper(name)] {
			continue
		}
		seen[strings.ToUpper(name)] = true
		out = append(out, v)
	}
	for _, f := range forced {
		if f.Value != "" && !seen[strings.ToUpper(f.Name)] {
			seen[strings.ToUpper(f.Name)] = true
			out = append(out, f.Name+"="+f.Value)
		}
	}
	slices.SortStableFunc(out, func(a, b string) int {
		na, _ := envName(a)
		nb, _ := envName(b)
		return strings.Compare(strings.ToUpper(na), strings.ToUpper(nb))
	})
	return out
}
