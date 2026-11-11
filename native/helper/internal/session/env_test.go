package session

import (
	"slices"
	"testing"
	"unicode/utf16"
)

func block(vars ...string) []uint16 {
	var b []uint16
	for _, v := range vars {
		b = append(b, utf16.Encode([]rune(v))...)
		b = append(b, 0)
	}
	return append(b, 0)
}

func TestParseEnvBlock(t *testing.T) {
	got := ParseEnvBlock(block("=C:=C:\\", "Path=C:\\Windows", "USERNAME=ali", "Ism=Ўзбек"))
	want := []string{"=C:=C:\\", "Path=C:\\Windows", "USERNAME=ali", "Ism=Ўзбек"}
	if !slices.Equal(got, want) {
		t.Fatalf("ParseEnvBlock = %q", got)
	}
	// Bo'sh blok (faqat ikki NUL) va oxirgi NUL'siz buzilgan blok.
	if got := ParseEnvBlock([]uint16{0, 0}); len(got) != 0 {
		t.Fatalf("bo'sh blok = %q", got)
	}
	if got := ParseEnvBlock(utf16.Encode([]rune("A=1"))); !slices.Equal(got, []string{"A=1"}) {
		t.Fatalf("NUL'siz blok = %q", got)
	}
}

func TestSerializeEnvBlockRoundTrip(t *testing.T) {
	vars := []string{"A=1", "Ism=Ўзбек", "Path=C:\\Windows;C:\\Windows\\System32"}
	b := SerializeEnvBlock(vars)
	if b[len(b)-1] != 0 || b[len(b)-2] != 0 {
		t.Fatalf("blok ikki NUL bilan tugashi kerak: %v", b[len(b)-4:])
	}
	if got := ParseEnvBlock(b); !slices.Equal(got, vars) {
		t.Fatalf("round trip = %q", got)
	}
	// Bo'sh ro'yxat ham yaroqli blok (CreateProcess uchun ikki NUL).
	if got := SerializeEnvBlock(nil); !slices.Equal(got, []uint16{0, 0}) {
		t.Fatalf("bo'sh blok = %v", got)
	}
}

func TestSanitizeEnvDropsControlledVariables(t *testing.T) {
	in := []string{
		"=C:=C:\\",
		"ELECTRON_RUN_AS_NODE=1",
		"electron_enable_logging=1",
		"NODE_OPTIONS=--require C:\\Users\\s\\x.js",
		"Node_Extra_CA_Certs=C:\\Users\\s\\ca.pem",
		"NETSCHOOL_COMPANION_DIR=C:\\Users\\s\\fake",
		"netschool_companion_state_dir=C:\\x",
		"npm_config_prefix=C:\\x",
		"CHROME_HEADLESS=1",
		"OPENSSL_CONF=C:\\x\\openssl.cnf",
		"SSLKEYLOGFILE=C:\\x\\keys.log",
		"__COMPAT_LAYER=RunAsInvoker",
		"ProgramData=C:\\Users\\s\\fake",
		"ALLUSERSPROFILE=C:\\Users\\s\\fake",
		"SystemRoot=C:\\Users\\s\\win",
		"windir=C:\\Users\\s\\win",
		"Path=C:\\Users\\s\\bin;C:\\Windows",
		"USERNAME=ali",
		"TEMP=C:\\Users\\ali\\AppData\\Local\\Temp",
		"NODEX=keep",
		"MY_ELECTRON_X=keep",
		"broken-without-equals",
	}
	forced := []EnvVar{
		{"ProgramData", `C:\ProgramData`},
		{"ALLUSERSPROFILE", `C:\ProgramData`},
		{"SystemRoot", `C:\Windows`},
		{"windir", `C:\Windows`},
		{"ProgramFiles", `C:\Program Files`},
		{"ProgramW6432", `C:\Program Files`},
		{"CommonProgramFiles", `C:\Program Files\Common Files`},
		{"Path", `C:\Windows\system32;C:\Windows`},
	}
	got := SanitizeEnv(in, forced)
	want := []string{
		"=C:=C:\\",
		"ALLUSERSPROFILE=C:\\ProgramData",
		"CommonProgramFiles=C:\\Program Files\\Common Files",
		"MY_ELECTRON_X=keep",
		"NODEX=keep",
		"Path=C:\\Windows\\system32;C:\\Windows",
		"ProgramData=C:\\ProgramData",
		"ProgramFiles=C:\\Program Files",
		"ProgramW6432=C:\\Program Files",
		"SystemRoot=C:\\Windows",
		"TEMP=C:\\Users\\ali\\AppData\\Local\\Temp",
		"USERNAME=ali",
		"windir=C:\\Windows",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("SanitizeEnv =\n%q\nkutilgan\n%q", got, want)
	}
}

func TestSanitizeEnvSkipsEmptyForcedValue(t *testing.T) {
	// Known Folder o'qilmagan (bo'sh qiymat): o'zgaruvchi umuman bo'lmaydi, foydalanuvchi qiymati ham qolmaydi.
	got := SanitizeEnv([]string{"ProgramW6432=C:\\Users\\s\\fake", "A=1"}, []EnvVar{{"ProgramW6432", ""}})
	if !slices.Equal(got, []string{"A=1"}) {
		t.Fatalf("SanitizeEnv = %q", got)
	}
}
