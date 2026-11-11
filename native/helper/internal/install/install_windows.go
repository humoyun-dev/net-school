//go:build windows

package install

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/humoyun-dev/net-school/native/helper/internal/cad"
	"github.com/humoyun-dev/net-school/native/helper/internal/fsacl"
	"github.com/humoyun-dev/net-school/native/helper/internal/hub"
	"github.com/humoyun-dev/net-school/native/helper/internal/layout"
	"github.com/humoyun-dev/net-school/native/helper/internal/policy"
	"github.com/humoyun-dev/net-school/native/helper/internal/service"
)

// stopTimeout xizmat to'xtashini kutish: xizmat Stop'da siyosat va Ctrl+Alt+Del'ni qaytaradi (PowerShell,
// service.StopTimeout), shundan keyin ham to'xtamasa jarayon majburan tugatiladi.
const stopTimeout = service.StopTimeout + 30*time.Second

// fileRetry o'chirilgan xizmat jarayoni exe'ni qo'yib yuborishini kutish (nusxa/o'chirish qayta uriniladi).
const fileRetry = 10 * time.Second

// Fayl nomlari: Companion `enroll` katalogidagi manba (apps/companion/src/core/machine-store.ts).
const (
	srcDeviceJSON = "device.json"
	srcHubCA      = "hub-ca.pem"
	srcHelperKey  = "helper.key"
)

// IsElevated jarayon administrator (UAC elevated) tokeni bilan ishlayaptimi.
func IsElevated() bool { return windows.GetCurrentProcessToken().IsElevated() }

// Paths Known Folders'dan helper yo'llari (muhit o'zgaruvchilariga ishonilmaydi).
func Paths() (layout.Paths, error) {
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return layout.Paths{}, fmt.Errorf("%%ProgramFiles%% aniqlanmadi: %w", err)
	}
	data, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return layout.Paths{}, fmt.Errorf("%%ProgramData%% aniqlanmadi: %w", err)
	}
	win, err := windows.KnownFolderPath(windows.FOLDERID_Windows, 0)
	if err != nil {
		return layout.Paths{}, fmt.Errorf("%%SystemRoot%% aniqlanmadi: %w", err)
	}
	return layout.New(pf, data, win), nil
}

// sources Companion enroll katalogidan o'qilgan, tekshirilgan helper konfiguratsiyasi.
type sources struct {
	deviceJSON []byte
	hubCA      []byte // nil — hub CA yo'q (tizim root'lari)
	helperKey  []byte // nil — manbada yo'q, helper katalogidagi (ishonchli) kalit qoladi
}

// readSources enroll katalogidan device.json, hub-ca.pem va helper.key'ni o'qiydi va tekshiradi. Hech narsa
// o'zgartirilishidan oldin chaqiriladi: yaroqsiz enrollment bilan xizmat o'rnatilmaydi.
func readSources(p layout.Paths, trusted bool) (sources, error) {
	var s sources
	raw, err := os.ReadFile(filepath.Join(p.EnrollDir, srcDeviceJSON))
	if err != nil {
		return s, fmt.Errorf("Companion enrollment topilmadi (avval enroll.cmd): %w", err)
	}
	if s.deviceJSON, err = HelperDeviceJSON(raw); err != nil {
		return s, err
	}
	s.hubCA, err = os.ReadFile(filepath.Join(p.EnrollDir, srcHubCA))
	if errors.Is(err, fs.ErrNotExist) {
		s.hubCA = nil
	} else if err != nil {
		return s, fmt.Errorf("hub-ca.pem o'qilmadi: %w", err)
	}
	keyPath := filepath.Join(p.EnrollDir, srcHelperKey)
	s.helperKey, err = os.ReadFile(keyPath)
	switch {
	case err == nil:
		if _, err := hub.LoadKey(keyPath); err != nil {
			return s, err
		}
	case !errors.Is(err, fs.ErrNotExist):
		return s, fmt.Errorf("helper.key o'qilmadi: %w", err)
	default:
		// Qayta o'rnatish (yangilash): kalit avvalgi install'da ko'chirilgan. Faqat helper katalogi bizniki bo'lsa
		// unga ishoniladi, aks holda kalitni o'quvchi qo'ygan bo'lishi mumkin.
		s.helperKey = nil
		if !trusted {
			return s, errors.New("helper.key yo'q: kompyuterni yangi token bilan qayta ro'yxatdan o'tkazing (enroll.cmd ... --force)")
		}
		if _, err := hub.LoadKey(p.HelperKey); err != nil {
			return s, fmt.Errorf("helper.key yo'q yoki yaroqsiz, qayta ro'yxatdan o'tkazing (enroll.cmd ... --force): %w", err)
		}
	}
	return s, nil
}

// Install helper'ni o'rnatadi (Task 11):
//  1. `%ProgramData%\NetSchool`, helper katalogi va Companion enroll katalogi egasi/DACL'i qayta o'rnatiladi;
//  2. enrollment o'qiladi va tekshiriladi;
//  3. eski xizmat (bo'lsa) to'xtatiladi;
//  4. `%ProgramFiles%\NetSchool\{helper,companion}`ga nusxa (SYSTEM/Administrators yozadi, Users o'qiydi);
//  5. helper katalogiga device.json, hub-ca.pem, helper.key yoziladi; manbadagi helper.key o'chiriladi;
//  6. Event Log manbasi, xizmat (SDDL, recovery), HKLM Run autostart o'chiriladi, xizmat ishga tushadi.
func Install(companionSrc string, out io.Writer) error {
	p, err := Paths()
	if err != nil {
		return err
	}
	companionSrc, err = filepath.Abs(companionSrc)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(companionSrc, layout.CompanionExe)); err != nil {
		return fmt.Errorf("--companion-dir'da %q yo'q: %w", layout.CompanionExe, err)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}

	trusted, err := fsacl.HardenHelperData(p.DataRoot, p.HelperData)
	if err != nil {
		return fmt.Errorf("helper katalogi himoyalanmadi: %w", err)
	}
	// Enroll katalogini o'quvchi oldindan yaratib, unga o'z hub-ca.pem'ini qo'ygan bo'lishi mumkin: o'qishdan oldin
	// himoyalanadi (Companion uni oddiy foydalanuvchi sifatida faqat o'qiydi).
	if _, err := fsacl.Harden(p.EnrollDir, fsacl.Readable); err != nil {
		return fmt.Errorf("Companion enroll katalogi himoyalanmadi: %w", err)
	}
	src, err := readSources(p, trusted)
	if err != nil {
		return err
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("xizmatlar boshqaruvchisi: %w", err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(service.Name); err == nil {
		fmt.Fprintln(out, "eski NetSchool Helper xizmati to'xtatilmoqda")
		err := stopAndWait(s, out)
		s.Close()
		if err != nil {
			return err
		}
	}

	fmt.Fprintf(out, "fayllar: %s\n", p.InstallRoot)
	if _, err := fsacl.Harden(p.InstallRoot, fsacl.Readable); err != nil {
		return fmt.Errorf("%s himoyalanmadi: %w", p.InstallRoot, err)
	}
	if err := os.MkdirAll(p.HelperDir, 0o755); err != nil {
		return err
	}
	if !samePath(self, p.HelperExe) {
		if err := retry(func() error { return copyFile(self, p.HelperExe) }); err != nil {
			return fmt.Errorf("helper nusxalanmadi: %w", err)
		}
	}
	if !samePath(companionSrc, p.CompanionDir) {
		if err := retry(func() error { return os.RemoveAll(p.CompanionDir) }); err != nil {
			return fmt.Errorf("eski Companion o'chirilmadi: %w", err)
		}
		if err := copyTree(companionSrc, p.CompanionDir); err != nil {
			return fmt.Errorf("Companion nusxalanmadi: %w", err)
		}
	}

	if !trusted {
		// Katalog bizniki emas edi (o'quvchi yoki meros DACL bilan yaratilgan): undagi lock/jurnal fayllariga
		// ishonilmaydi.
		if err := fsacl.Clear(p.HelperData); err != nil {
			return fmt.Errorf("helper katalogi tozalanmadi: %w", err)
		}
	}
	if err := writeAtomic(p.DeviceJSON, src.deviceJSON); err != nil {
		return err
	}
	if src.hubCA != nil {
		err = writeAtomic(p.HubCA, src.hubCA)
	} else {
		err = removeIfExists(p.HubCA)
	}
	if err != nil {
		return err
	}
	if src.helperKey != nil {
		if err := writeAtomic(p.HelperKey, src.helperKey); err != nil {
			return err
		}
		// Enroll katalogini foydalanuvchilar o'qiydi: kalit u yerda qolmasin.
		if err := os.Remove(filepath.Join(p.EnrollDir, srcHelperKey)); err != nil {
			return fmt.Errorf("enroll katalogidagi helper.key o'chirilmadi: %w", err)
		}
	}

	_ = eventlog.Remove(service.EventSource)
	if err := eventlog.InstallAsEventCreate(service.EventSource, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		fmt.Fprintf(out, "ogohlantirish: Event Log manbasi ro'yxatdan o'tmadi: %v\n", err)
	}

	s, err := createOrUpdate(m, p.HelperExe)
	if err != nil {
		return err
	}
	defer s.Close()

	if err := removeRunValue(); err != nil {
		return fmt.Errorf("eski autostart (HKLM Run) o'chirilmadi: %w", err)
	}
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return fmt.Errorf("xizmat ishga tushmadi: %w", err)
	}
	fmt.Fprintln(out, "NetSchool Helper o'rnatildi va ishga tushdi")
	return nil
}

// createOrUpdate xizmatni yaratadi yoki mavjudining konfiguratsiyasini yangilaydi, keyin SDDL va recovery'ni
// o'rnatadi (ikkala holatda ham: qo'lda o'zgartirilgan bo'lsa qaytadi).
func createOrUpdate(m *mgr.Mgr, exe string) (*mgr.Service, error) {
	s, err := m.OpenService(service.Name)
	if err == nil {
		cfg, err := s.Config()
		if err == nil {
			cfg.BinaryPathName = syscall.EscapeArg(exe) + " run"
			cfg.StartType = mgr.StartAutomatic
			cfg.ErrorControl = mgr.ErrorNormal
			cfg.ServiceStartName = "LocalSystem"
			cfg.DisplayName = DisplayName
			cfg.Description = Description
			cfg.DelayedAutoStart = false
			err = s.UpdateConfig(cfg)
		}
		if err != nil {
			s.Close()
			return nil, fmt.Errorf("xizmat konfiguratsiyasi yangilanmadi: %w", err)
		}
	} else {
		s, err = m.CreateService(service.Name, exe, mgr.Config{
			StartType:        mgr.StartAutomatic,
			ErrorControl:     mgr.ErrorNormal,
			ServiceStartName: "LocalSystem",
			DisplayName:      DisplayName,
			Description:      Description,
		}, "run")
		if err != nil {
			return nil, fmt.Errorf("xizmat yaratilmadi: %w", err)
		}
	}
	if err := protect(s); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

var procSetServiceObjectSecurity = windows.NewLazySystemDLL("advapi32.dll").NewProc("SetServiceObjectSecurity")

// protect xizmat DACL'i (ServiceSDDL) va qulaganda qayta ishga tushirish.
func protect(s *mgr.Service) error {
	sd, err := windows.SecurityDescriptorFromString(ServiceSDDL)
	if err != nil {
		return err
	}
	r, _, callErr := procSetServiceObjectSecurity.Call(uintptr(s.Handle),
		uintptr(windows.DACL_SECURITY_INFORMATION), uintptr(unsafe.Pointer(sd)))
	if r == 0 {
		return fmt.Errorf("xizmat DACL'i o'rnatilmadi: %w", callErr)
	}
	actions := make([]mgr.RecoveryAction, len(RecoveryDelaysMs))
	for i, ms := range RecoveryDelaysMs {
		actions[i] = mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: time.Duration(ms) * time.Millisecond}
	}
	if err := s.SetRecoveryActions(actions, RecoveryResetSeconds); err != nil {
		return fmt.Errorf("recovery o'rnatilmadi: %w", err)
	}
	// Nol bo'lmagan kod bilan chiqish ham "qulash" hisoblanadi.
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return fmt.Errorf("recovery (non-crash) o'rnatilmadi: %w", err)
	}
	return nil
}

// stopAndWait xizmatni to'xtatadi va to'xtashini kutadi. stopTimeout ichida to'xtamasa jarayon majburan
// tugatiladi (siyosat va Ctrl+Alt+Del'ni keyin Uninstall jurnaldan qaytaradi; Install'da yangi xizmat Start'i).
func stopAndWait(s *mgr.Service, out io.Writer) error {
	st, err := s.Query()
	if err != nil {
		return fmt.Errorf("xizmat holati: %w", err)
	}
	if st.State == svc.Stopped {
		return nil
	}
	if st.State != svc.StopPending {
		if _, err := s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return fmt.Errorf("xizmat to'xtatilmadi: %w", err)
		}
	}
	deadline := time.Now().Add(stopTimeout)
	pid := st.ProcessId
	for time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		st, err = s.Query()
		if err != nil {
			return fmt.Errorf("xizmat holati: %w", err)
		}
		if st.ProcessId != 0 {
			pid = st.ProcessId
		}
		if st.State == svc.Stopped {
			return nil
		}
	}
	fmt.Fprintf(out, "ogohlantirish: xizmat %s ichida to'xtamadi, jarayon %d tugatiladi\n", stopTimeout, pid)
	return terminate(pid)
}

func terminate(pid uint32) error {
	if pid == 0 {
		return nil
	}
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return fmt.Errorf("jarayon %d ochilmadi: %w", pid, err)
	}
	defer windows.CloseHandle(h)
	if err := windows.TerminateProcess(h, 1); err != nil {
		return fmt.Errorf("jarayon %d tugatilmadi: %w", pid, err)
	}
	_, _ = windows.WaitForSingleObject(h, 10_000)
	return nil
}

// removeRunValue P0c `enroll.cmd` yozgan HKLM Run qiymatini o'chiradi (yo'q bo'lsa — xato emas).
func removeRunValue() error {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, RunKey, registry.SET_VALUE|registry.WOW64_64KEY)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(RunValue); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

// Uninstall xizmatni to'xtatadi va o'chiradi. Xizmat Stop'da siyosat va Ctrl+Alt+Del'ni qaytaradi; jurnal
// qolgan bo'lsa (xizmat qulagan yoki majburan tugatilgan) uninstall o'zi qaytaradi. Qaytarib bo'lmasa helper
// ma'lumot katalogi (jurnallar) o'chirilmaydi va xato qaytariladi: o'quvchi kompyuteri siyosat bilan qolmasin.
// Companion enrollment'i (`%ProgramData%\NetSchool\companion`) tegilmaydi.
func Uninstall(out io.Writer) error {
	p, err := Paths()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("xizmatlar boshqaruvchisi: %w", err)
	}
	defer m.Disconnect()

	var errs []error
	if s, err := m.OpenService(service.Name); err == nil {
		fmt.Fprintln(out, "NetSchool Helper xizmati to'xtatilmoqda")
		if err := stopAndWait(s, out); err != nil {
			errs = append(errs, err)
		}
		if err := s.Delete(); err != nil {
			errs = append(errs, fmt.Errorf("xizmat o'chirilmadi: %w", err))
		}
		s.Close()
	} else if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return fmt.Errorf("xizmat ochilmadi: %w", err)
	}

	restoreErr := restoreLeftovers(p, out)
	if restoreErr != nil {
		errs = append(errs, restoreErr)
	}
	if err := eventlog.Remove(service.EventSource); err != nil {
		fmt.Fprintf(out, "ogohlantirish: Event Log manbasi o'chirilmadi: %v\n", err)
	}
	if err := removeRunValue(); err != nil {
		errs = append(errs, fmt.Errorf("HKLM Run autostart o'chirilmadi: %w", err))
	}
	if err := retry(func() error { return os.RemoveAll(p.InstallRoot) }); err != nil {
		errs = append(errs, fmt.Errorf("%s o'chirilmadi: %w", p.InstallRoot, err))
	}
	if restoreErr == nil {
		if err := os.RemoveAll(p.HelperData); err != nil {
			errs = append(errs, fmt.Errorf("%s o'chirilmadi: %w", p.HelperData, err))
		}
	} else {
		fmt.Fprintf(out, "jurnallar %s da saqlandi: tiklash uchun uninstall'ni qayta ishga tushiring\n", p.HelperData)
	}
	if len(errs) == 0 {
		fmt.Fprintln(out, "NetSchool Helper olib tashlandi")
	}
	return errors.Join(errs...)
}

// restoreLeftovers xizmat to'xtagandan keyin qolgan siyosat va Ctrl+Alt+Del jurnallarini qaytaradi (xizmatdagi
// bilan bir xil kod: policy.Restore, cad.Guard.Retry).
func restoreLeftovers(p layout.Paths, out io.Writer) error {
	var errs []error
	pol := policy.NewPolicy(policy.NewRegistry(), p.PolicyJournal)
	if pol.Pending() {
		fmt.Fprintln(out, "qolgan bloklash siyosati qaytarilmoqda")
		if err := pol.Restore(); err != nil {
			errs = append(errs, fmt.Errorf("siyosat qaytarilmadi: %w", err))
		}
	}
	g := cad.NewGuard(cad.NewKeyboardFilter(), p.CADJournal)
	if g.Pending() {
		fmt.Fprintln(out, "Ctrl+Alt+Del bloki olib tashlanmoqda")
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		g.Retry(ctx)
		cancel()
		if g.Pending() {
			errs = append(errs, fmt.Errorf("Ctrl+Alt+Del bloki olib tashlanmadi: %s", g.Reason()))
		}
	}
	return errors.Join(errs...)
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// retry o'chirilayotgan xizmat jarayoni fayllarni qo'yib yuborguncha (fileRetry) qayta urinadi.
func retry(f func() error) error {
	deadline := time.Now().Add(fileRetry)
	for {
		err := f()
		if err == nil || time.Now().After(deadline) {
			return err
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// writeAtomic vaqtinchalik fayl + rename: yangi fayl katalog DACL'ini meros oladi, eski nom (masalan, o'quvchi
// qo'ygan hard link) almashtiriladi.
func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("%s yozilmadi: %w", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("%s yozilmadi: %w", path, err)
	}
	return nil
}

func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return writeAtomic(dst, data)
}

// copyTree yoyilgan paketni Companion katalogiga nusxalaydi. netschool-helper.exe (u helper katalogida) va reparse
// point'lar o'tkazib yuboriladi.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if rel == layout.HelperExe {
			return nil
		}
		return copyStream(path, target)
	})
}

func copyStream(src, dst string) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := out.Close(); err == nil {
			err = cerr
		}
	}()
	_, err = io.Copy(out, in)
	return err
}
