//go:build windows

package cad

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// keyboardFilterService Keyboard Filter xizmati. U faqat funksiya yoqilgan (Client-KeyboardFilter) va kompyuter
// qayta ishga tushirilgandan keyin mavjud va ishlaydi; Pro/Home'da funksiyaning o'zi yo'q.
const keyboardFilterService = "MsKeyboardFilter"

const (
	// commandTimeout bitta powershell.exe chaqiruvining chegarasi (Get-WindowsOptionalFeature DISM'ni yuklaydi, sekin).
	commandTimeout = 30 * time.Second
	// waitDelay kontekst tugagach (jarayon o'ldirilgach) chiqish quvurlari yopilishini kutish chegarasi: PowerShell
	// bola jarayon qoldirib, quvurni ushlab tursa ham Run osilib qolmaydi.
	waitDelay = 5 * time.Second
	// maxStderr xatoga qo'shiladigan stderr'ning yuqori chegarasi (bayt).
	maxStderr = 512
)

// PowerShell skriptlari. Hammasi qat'iy konstanta: ichida tashqi matn yo'q, hech narsa interpolyatsiya qilinmaydi.
// Bir qatorda yozilgan va faqat bitta tirnoqlar ishlatiladi (buyruq qatoridagi `"` qochirish muammosi bo'lmasligi
// uchun). `Stop` har bir xatoni to'xtatuvchi qiladi: powershell.exe noldan farqli kod bilan chiqadi. `throw` matnlari
// inglizcha va apostrofsiz: ular stderr orqali xatoga tushadi.
// Get-WmiObject + Put() — Microsoft hujjatidagi usul (WEKF_PredefinedKey: [Key] Id, [Read, Write] Enabled).
//
// Eslatma: Keyboard Filter sukut bo'yicha administrator hisoblari uchun ishlamaydi
// (WEKF_Settings.DisableKeyboardFilterForAdministrators). O'quvchilar standart foydalanuvchi (P2h), shuning uchun
// bu sozlama O'ZGARTIRILMAYDI: administratorni to'sish xizmat ko'rsatishni qulflab qo'yishi mumkin.
const (
	// scriptFeatureState funksiya holatini chop etadi (Enabled | Disabled | EnablePending | ...).
	scriptFeatureState = `$ProgressPreference = 'SilentlyContinue'; ` +
		`$ErrorActionPreference = 'Stop'; ` +
		`$f = Get-WindowsOptionalFeature -Online -FeatureName Client-KeyboardFilter; ` +
		`[string]$f.State`

	// scriptBlock Ctrl+Alt+Del va Win+L'ni yoqadi va har birini qayta o'qib tekshiradi.
	scriptBlock = `$ProgressPreference = 'SilentlyContinue'; ` +
		`$ErrorActionPreference = 'Stop'; ` +
		`$ns = 'root\standardcimv2\embedded'; ` +
		`foreach ($id in 'Ctrl+Alt+Del', 'Win+L') { ` +
		`$k = Get-WmiObject -Namespace $ns -Class WEKF_PredefinedKey | Where-Object { $_.Id -eq $id }; ` +
		`if (-not $k) { throw ('not found: ' + $id) }; ` +
		`$k.Enabled = $true; ` +
		`$null = $k.Put(); ` +
		`$v = Get-WmiObject -Namespace $ns -Class WEKF_PredefinedKey | Where-Object { $_.Id -eq $id }; ` +
		`if (-not $v.Enabled) { throw ('not enabled: ' + $id) } }`

	// scriptUnblock Ctrl+Alt+Del va Win+L'ni o'chiradi va har birini qayta o'qib tekshiradi.
	scriptUnblock = `$ProgressPreference = 'SilentlyContinue'; ` +
		`$ErrorActionPreference = 'Stop'; ` +
		`$ns = 'root\standardcimv2\embedded'; ` +
		`foreach ($id in 'Ctrl+Alt+Del', 'Win+L') { ` +
		`$k = Get-WmiObject -Namespace $ns -Class WEKF_PredefinedKey | Where-Object { $_.Id -eq $id }; ` +
		`if (-not $k) { throw ('not found: ' + $id) }; ` +
		`$k.Enabled = $false; ` +
		`$null = $k.Put(); ` +
		`$v = Get-WmiObject -Namespace $ns -Class WEKF_PredefinedKey | Where-Object { $_.Id -eq $id }; ` +
		`if ($v.Enabled) { throw ('not disabled: ' + $id) } }`
)

// stateToken skript chop etgan funksiya holati: faqat harflar. Boshqa narsa sababga qo'shilmaydi.
var stateToken = regexp.MustCompile(`^[A-Za-z]{1,32}$`)

// KeyboardFilter Backend'ning Windows Keyboard Filter realizatsiyasi (WMI `root\standardcimv2\embedded`).
// Chaqiruvchi LocalSystem xizmati bo'lishi kerak: WEKF_PredefinedKey'ni faqat administrator o'zgartira oladi.
type KeyboardFilter struct {
	// run PowerShell skriptini bajarib, stdout'ni qaytaradi (testlarda almashtiriladi).
	run func(ctx context.Context, script string) (string, error)
	// service xizmatning mavjudligi va ishlayotganini qaytaradi (testlarda almashtiriladi).
	service func(name string) (installed, running bool, err error)
}

var _ Backend = (*KeyboardFilter)(nil)

// NewKeyboardFilter haqiqiy powershell.exe va xizmatlar boshqaruvchisidan foydalanadigan backend'ni qaytaradi.
func NewKeyboardFilter() *KeyboardFilter {
	return &KeyboardFilter{run: runPowerShell, service: serviceState}
}

// Available: avval PowerShell'siz xizmat tekshiriladi (Pro/Home'da xizmat yo'q, ya'ni `edition`, va PowerShell
// umuman ishga tushmaydi), keyin funksiya holati. false bo'lsa ikkinchi qiymat: ReasonEdition (funksiya yo'q,
// yoqilmagan yoki xizmat yo'q) yoki probe xatosi / hali tayyor emasligi matni (Guard buni `failed` deydi).
func (k *KeyboardFilter) Available() (bool, string) {
	installed, running, err := k.service(keyboardFilterService)
	if err != nil {
		return false, fmt.Sprintf("%s xizmati tekshirilmadi: %v", keyboardFilterService, err)
	}
	if !installed {
		return false, ReasonEdition
	}

	out, err := k.run(context.Background(), scriptFeatureState)
	if err != nil {
		return false, fmt.Sprintf("Client-KeyboardFilter holati o'qilmadi: %v", err)
	}
	switch state := strings.TrimSpace(out); {
	case state == "Enabled":
	case state == "Disabled":
		return false, ReasonEdition
	case stateToken.MatchString(state):
		// Masalan EnablePending: yoqilgan, lekin kompyuter qayta ishga tushirilmagan.
		return false, "Client-KeyboardFilter holati: " + state
	default:
		return false, "Client-KeyboardFilter holati tushunarsiz"
	}

	// Funksiya yoqilgan, lekin xizmat ishlamayotgan bo'lsa filtr qoidalarni yozib qo'ysa ham to'smaydi:
	// "bloklandi" deb aytmaymiz.
	if !running {
		return false, keyboardFilterService + " xizmati ishlamayapti"
	}
	return true, ""
}

// Block Ctrl+Alt+Del va Win+L'ni to'sadi.
func (k *KeyboardFilter) Block(ctx context.Context) error {
	if _, err := k.run(ctx, scriptBlock); err != nil {
		return fmt.Errorf("Ctrl+Alt+Del to'silmadi: %w", err)
	}
	return nil
}

// Unblock Ctrl+Alt+Del va Win+L'ni qaytaradi.
func (k *KeyboardFilter) Unblock(ctx context.Context) error {
	if _, err := k.run(ctx, scriptUnblock); err != nil {
		return fmt.Errorf("Ctrl+Alt+Del qaytarilmadi: %w", err)
	}
	return nil
}

// powershellPath Windows PowerShell 5.1'ning mutlaq yo'li: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.
// SystemRoot muhit o'zgaruvchisidan emas, tizimdan so'raladi (GetSystemWindowsDirectory), PATH qidirilmaydi: boshqa
// powershell.exe yoki pwsh.exe o'rniga tushib qolmaydi.
func powershellPath() (string, error) {
	dir, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		return "", fmt.Errorf("Windows katalogi aniqlanmadi: %w", err)
	}
	return filepath.Join(dir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), nil
}

// powershellArgs powershell.exe argumentlari: faqat qat'iy bayroqlar va qat'iy skript.
func powershellArgs(script string) []string {
	return []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script}
}

// runPowerShell skriptni powershell.exe'da bajaradi (oyna ko'rinmaydi, commandTimeout bilan) va stdout'ni qaytaradi.
// Xato bo'lsa stderr (qisqartirilgan) xatoga qo'shiladi.
func runPowerShell(ctx context.Context, script string) (string, error) {
	exe, err := powershellPath()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, exe, powershellArgs(script)...)
	cmd.Dir = filepath.Dir(exe)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = waitDelay
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}

	if err := cmd.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			err = fmt.Errorf("%w (%w)", err, ctxErr)
		}
		return "", fmt.Errorf("powershell.exe: %w: %s", err, truncate(stderr.String(), maxStderr))
	}
	return stdout.String(), nil
}

// truncate s'ni bo'shliqlardan tozalab, ko'pi bilan limit baytgacha qisqartiradi (stderr xato xabariga qo'shiladi).
// PowerShell stderr'i OEM kodlashda bo'lishi mumkin: yaroqsiz UTF-8 baytlar '?' bilan almashtiriladi.
func truncate(s string, limit int) string {
	s = strings.TrimSpace(s)
	if len(s) > limit {
		s = s[:limit] + "..."
	}
	return strings.ToValidUTF8(s, "?")
}

// serviceState name xizmati o'rnatilganligi va ishlayotganini qaytaradi. Eng kam huquq bilan ochiladi
// (SC_MANAGER_CONNECT va SERVICE_QUERY_STATUS): svc/mgr.Connect SC_MANAGER_ALL_ACCESS so'raydi, bu administratorsiz
// (masalan, testda) ochilmaydi, bu yerda esa faqat o'qish kerak.
func serviceState(name string) (installed, running bool, err error) {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return false, false, fmt.Errorf("xizmatlar boshqaruvchisi ochilmadi: %w", err)
	}
	defer windows.CloseServiceHandle(scm)

	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return false, false, err
	}
	h, err := windows.OpenService(scm, namePtr, windows.SERVICE_QUERY_STATUS)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("%s ochilmadi: %w", name, err)
	}
	defer windows.CloseServiceHandle(h)

	var status windows.SERVICE_STATUS
	if err := windows.QueryServiceStatus(h, &status); err != nil {
		return false, false, fmt.Errorf("%s holati o'qilmadi: %w", name, err)
	}
	return true, status.CurrentState == windows.SERVICE_RUNNING, nil
}
