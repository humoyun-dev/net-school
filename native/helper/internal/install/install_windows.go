//go:build windows

package install

import (
	"context"
	"crypto/ed25519"
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

// fileRetry to'xtatilgan xizmat jarayoni fayllarni qo'yib yuborishini kutish (rename/o'chirish qayta uriniladi).
const fileRetry = 10 * time.Second

// ErrRunFromInstallDir uninstall `%ProgramFiles%\NetSchool` ichidagi exe'dan ishga tushirilgan: o'zini o'chira
// olmaydi.
var ErrRunFromInstallDir = errors.New("uninstall paket katalogidagi uninstall.cmd (netschool-helper.exe) dan ishga tushirilishi kerak, o'rnatilgan nusxadan emas")

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

// HelperKey (`helper-key --token`, enroll claim'dan oldin chaqiradi) helper katalogini himoyalaydi va helper
// kalitini tayyorlaydi: rotate=false va katalogda yaroqli helper.key bo'lsa — o'sha (qayta urinish yoki bir xil
// kalit bilan qayta ro'yxatdan o'tish), aks holda yangi kalit helper.key.pending'ga yoziladi va set-hub claim
// muvaffaqiyatidan keyin uni helper.key qiladi. Kalit hech qachon helper katalogidan chiqmaydi.
func HelperKey(token string, rotate bool) (HelperKeyResult, error) {
	if err := ValidateToken(token); err != nil {
		return HelperKeyResult{}, err
	}
	p, err := Paths()
	if err != nil {
		return HelperKeyResult{}, err
	}
	data, err := fsacl.HardenHelperData(p.DataRoot, p.HelperData)
	if err != nil {
		return HelperKeyResult{DataRootReplaced: data.RootReplaced}, fmt.Errorf("helper katalogi himoyalanmadi: %w", err)
	}
	var key ed25519.PrivateKey
	if !rotate {
		key, _ = hub.LoadKey(p.HelperKey)
	}
	if key == nil {
		pemBytes, k, err := hub.GenerateKeyPEM()
		if err != nil {
			return HelperKeyResult{}, err
		}
		if err := writeAtomic(p.HelperKeyPending, pemBytes); err != nil {
			return HelperKeyResult{}, err
		}
		key = k
	} else if err := removeIfExists(p.HelperKeyPending); err != nil {
		return HelperKeyResult{}, err
	}
	pub, err := hub.EncodePublicKey(key.Public().(ed25519.PublicKey))
	if err != nil {
		return HelperKeyResult{}, err
	}
	return HelperKeyResult{HelperPublicKey: pub, HelperProof: hub.ClaimProof(key, token, pub), DataRootReplaced: data.RootReplaced}, nil
}

// SetHub (`set-hub`, enroll claim muvaffaqiyatidan keyin chaqiradi) hub konfiguratsiyasini helper katalogiga
// yozadi: device.json, hub-ca.pem (ca nil — eski hub-ca.pem o'chiriladi) va kutayotgan kalitni helper.key qiladi.
// ca — enroll claim'dan oldin tekshirgan baytlar (stdin orqali); bu yerda yana tekshiriladi.
func SetHub(origin, deviceID string, ca []byte) error {
	deviceJSON, err := ValidateHub(origin, deviceID, ca)
	if err != nil {
		return err
	}
	p, err := Paths()
	if err != nil {
		return err
	}
	if _, err := fsacl.HardenHelperData(p.DataRoot, p.HelperData); err != nil {
		return fmt.Errorf("helper katalogi himoyalanmadi: %w", err)
	}
	if _, err := os.Stat(p.HelperKeyPending); err == nil {
		if _, err := hub.LoadKey(p.HelperKeyPending); err != nil {
			return err
		}
		if err := os.Rename(p.HelperKeyPending, p.HelperKey); err != nil {
			return fmt.Errorf("helper kaliti o'rnatilmadi: %w", err)
		}
	}
	if _, err := hub.LoadKey(p.HelperKey); err != nil {
		return fmt.Errorf("helper.key yo'q (avval helper-key): %w", err)
	}
	if err := writeAtomic(p.DeviceJSON, deviceJSON); err != nil {
		return err
	}
	if ca != nil {
		return writeAtomic(p.HubCA, ca)
	}
	return removeIfExists(p.HubCA)
}

// swap katalogni yangisiga almashtirish qadami (orqaga qaytarish uchun yoziladi).
type swap struct{ dir, staged, old string }

// Install helper'ni o'rnatadi yoki yangilaydi. Helper konfiguratsiyasi (device.json, helper.key, hub-ca.pem)
// faqat helper katalogidan: uni enroll `helper-key`/`set-hub` orqali to'ldiradi; yo'q bo'lsa xizmat baribir
// o'rnatiladi va ogohlantirish chiqadi.
//
// Fayllar avval `helper.new`, `companion.new`ga to'liq nusxalanadi, keyin rename bilan almashtiriladi (eskisi
// `*.old` bo'lib muvaffaqiyatgacha turadi). Eski xizmat to'xtatilgandan keyingi har qanday xatoda rename'lar
// qaytariladi va eski xizmat qayta ishga tushiriladi: kompyuter boshqaruvsiz qolmasin.
func Install(companionSrc string, out io.Writer) (err error) {
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

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("xizmatlar boshqaruvchisi: %w", err)
	}
	defer m.Disconnect()

	var swaps []swap
	oldService, created := false, false
	defer func() {
		if err == nil {
			return
		}
		for i := len(swaps) - 1; i >= 0; i-- {
			if rerr := undoSwap(swaps[i]); rerr != nil {
				fmt.Fprintf(out, "ogohlantirish: %s qaytarilmadi: %v\n", swaps[i].dir, rerr)
			}
		}
		if created {
			if s, oerr := m.OpenService(service.Name); oerr == nil {
				_ = s.Delete()
				s.Close()
			}
		}
		if oldService {
			if s, oerr := m.OpenService(service.Name); oerr == nil {
				if serr := s.Start(); serr != nil && !errors.Is(serr, windows.ERROR_SERVICE_ALREADY_RUNNING) {
					fmt.Fprintf(out, "ogohlantirish: eski xizmat qayta ishga tushmadi: %v\n", serr)
				} else {
					fmt.Fprintln(out, "eski xizmat qayta ishga tushirildi")
				}
				s.Close()
			}
		}
	}()

	if s, oerr := m.OpenService(service.Name); oerr == nil {
		oldService = true
		fmt.Fprintln(out, "eski NetSchool Helper xizmati to'xtatilmoqda")
		terminated, serr := stopAndWait(s, out)
		s.Close()
		if serr != nil {
			return serr
		}
		// Majburan tugatilgan xizmat siyosat/CAD'ni qaytarmagan: katalog tozalanishidan (ishonchsiz bo'lsa)
		// OLDIN jurnal bo'yicha qaytariladi. Jurnal faqat bloklash siyosatining qiymatlarini qabul qiladi.
		if terminated {
			if rerr := restoreLeftovers(p, out); rerr != nil {
				fmt.Fprintf(out, "ogohlantirish: %v\n", rerr)
			}
		}
	}

	data, err := fsacl.HardenHelperData(p.DataRoot, p.HelperData)
	if data.RootReplaced {
		fmt.Fprintln(out, fsacl.RootReplacedWarning)
	}
	if err != nil {
		return fmt.Errorf("helper katalogi himoyalanmadi: %w", err)
	}
	if !data.HelperTrusted {
		fmt.Fprintf(out, "ogohlantirish: %s ishonchsiz edi (egasi yoki DACL boshqa), tozalandi\n", p.HelperData)
	}
	warnIfNotEnrolled(p, out)

	fmt.Fprintf(out, "fayllar: %s\n", p.InstallRoot)
	if t, err := fsacl.HardenDir(p.InstallRoot, fsacl.Readable); err != nil {
		return fmt.Errorf("%s himoyalanmadi: %w", p.InstallRoot, err)
	} else if !t {
		fmt.Fprintf(out, "ogohlantirish: %s ishonchsiz edi, tozalandi\n", p.InstallRoot)
	}
	plan := []swap{
		{dir: p.HelperDir, staged: p.HelperDir + ".new", old: p.HelperDir + ".old"},
		{dir: p.CompanionDir, staged: p.CompanionDir + ".new", old: p.CompanionDir + ".old"},
	}
	for _, s := range plan {
		if err := fsacl.FreshDir(s.staged, fsacl.Readable); err != nil {
			return err
		}
		if err := fsacl.RemoveTree(s.old); err != nil {
			return fmt.Errorf("eski %s o'chirilmadi: %w", s.old, err)
		}
	}
	if err := copyFile(self, filepath.Join(plan[0].staged, layout.HelperExe)); err != nil {
		return fmt.Errorf("helper nusxalanmadi: %w", err)
	}
	if err := copyTree(companionSrc, plan[1].staged); err != nil {
		return fmt.Errorf("Companion nusxalanmadi: %w", err)
	}
	for _, s := range plan {
		done, err := applySwap(s)
		swaps = append(swaps, done...)
		if err != nil {
			return err
		}
	}

	_ = eventlog.Remove(service.EventSource)
	if err := eventlog.InstallAsEventCreate(service.EventSource, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		fmt.Fprintf(out, "ogohlantirish: Event Log manbasi ro'yxatdan o'tmadi: %v\n", err)
	}
	s, isNew, err := createOrUpdate(m, p.HelperExe)
	created = isNew
	if err != nil {
		return err
	}
	defer s.Close()
	if err := removeRunValue(); err != nil {
		fmt.Fprintf(out, "ogohlantirish: eski autostart (HKLM Run) o'chirilmadi: %v\n", err)
	}
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return fmt.Errorf("xizmat ishga tushmadi: %w", err)
	}
	for _, sw := range plan {
		if err := retry(func() error { return fsacl.RemoveTree(sw.old) }); err != nil {
			fmt.Fprintf(out, "ogohlantirish: %s o'chirilmadi: %v\n", sw.old, err)
		}
	}
	fmt.Fprintln(out, "NetSchool Helper o'rnatildi va ishga tushdi")
	return nil
}

// applySwap dir'ni old'ga (bo'lsa), staged'ni dir'ga ko'chiradi. Bajarilgan qadamlar qaytariladi (orqaga
// qaytarish uchun). Ishlayotgan exe'ni qayta nomlash Windows'da mumkin.
func applySwap(s swap) ([]swap, error) {
	var done []swap
	if _, err := os.Lstat(s.dir); err == nil {
		if err := retry(func() error { return os.Rename(s.dir, s.old) }); err != nil {
			return done, fmt.Errorf("%s chetga olinmadi: %w", s.dir, err)
		}
		done = append(done, swap{dir: s.dir, old: s.old})
	}
	if err := os.Rename(s.staged, s.dir); err != nil {
		return done, fmt.Errorf("%s o'rnatilmadi: %w", s.dir, err)
	}
	return append(done, swap{dir: s.dir, staged: s.staged}), nil
}

// undoSwap applySwap qadamini qaytaradi: yangi katalog staged'ga, eski katalog joyiga.
func undoSwap(s swap) error {
	if s.staged != "" {
		return os.Rename(s.dir, s.staged)
	}
	return os.Rename(s.old, s.dir)
}

// warnIfNotEnrolled helper katalogida hub konfiguratsiyasi yoki kalit bo'lmasa ogohlantiradi: xizmat ishlaydi,
// lekin hub'ga ulanmaydi.
func warnIfNotEnrolled(p layout.Paths, out io.Writer) {
	raw, err := os.ReadFile(p.DeviceJSON)
	if err == nil {
		_, err = service.ParseDeviceConfig(raw)
	}
	if err == nil {
		_, err = hub.LoadKey(p.HelperKey)
	}
	if err != nil {
		fmt.Fprintf(out, "ogohlantirish: helper ro'yxatdan o'tmagan (%v): enroll.cmd ni ishga tushiring\n", err)
	}
}

// createOrUpdate xizmatni yaratadi yoki mavjudining konfiguratsiyasini yangilaydi, keyin SDDL va recovery'ni
// o'rnatadi (ikkala holatda ham: qo'lda o'zgartirilgan bo'lsa qaytadi). created — xizmat shu chaqiruvda yaratildi.
func createOrUpdate(m *mgr.Mgr, exe string) (s *mgr.Service, created bool, err error) {
	s, err = m.OpenService(service.Name)
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
			return nil, false, fmt.Errorf("xizmat konfiguratsiyasi yangilanmadi: %w", err)
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
			return nil, false, fmt.Errorf("xizmat yaratilmadi: %w", err)
		}
		created = true
	}
	if err := protect(s); err != nil {
		s.Close()
		return nil, created, err
	}
	return s, created, nil
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
// tugatiladi (terminated=true: xizmat siyosat va Ctrl+Alt+Del'ni qaytarmagan bo'lishi mumkin).
func stopAndWait(s *mgr.Service, out io.Writer) (terminated bool, err error) {
	st, err := s.Query()
	if err != nil {
		return false, fmt.Errorf("xizmat holati: %w", err)
	}
	if st.State == svc.Stopped {
		return false, nil
	}
	if st.State != svc.StopPending {
		if _, err := s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return false, fmt.Errorf("xizmat to'xtatilmadi: %w", err)
		}
	}
	deadline := time.Now().Add(stopTimeout)
	pid := st.ProcessId
	for time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		st, err = s.Query()
		if err != nil {
			return false, fmt.Errorf("xizmat holati: %w", err)
		}
		if st.ProcessId != 0 {
			pid = st.ProcessId
		}
		if st.State == svc.Stopped {
			return false, nil
		}
	}
	fmt.Fprintf(out, "ogohlantirish: xizmat %s ichida to'xtamadi, jarayon %d tugatiladi\n", stopTimeout, pid)
	return true, terminate(pid)
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
// Companion enrollment'i (`%ProgramData%\NetSchool\companion`) tegilmaydi. Paket katalogidan ishga tushiriladi.
func Uninstall(out io.Writer) error {
	p, err := Paths()
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if within(self, p.InstallRoot) {
		return ErrRunFromInstallDir
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("xizmatlar boshqaruvchisi: %w", err)
	}
	defer m.Disconnect()

	var errs []error
	if s, err := m.OpenService(service.Name); err == nil {
		fmt.Fprintln(out, "NetSchool Helper xizmati to'xtatilmoqda")
		if _, err := stopAndWait(s, out); err != nil {
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
		fmt.Fprintf(out, "ogohlantirish: HKLM Run autostart o'chirilmadi: %v\n", err)
	}
	if err := retry(func() error { return fsacl.RemoveTree(p.InstallRoot) }); err != nil {
		errs = append(errs, fmt.Errorf("%s o'chirilmadi: %w", p.InstallRoot, err))
	}
	if restoreErr == nil {
		if err := fsacl.RemoveTree(p.HelperData); err != nil {
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

// within path root ichidami (registrsiz).
func within(path, root string) bool {
	path, root = strings.ToLower(filepath.Clean(path)), strings.ToLower(filepath.Clean(root))
	return path == root || strings.HasPrefix(path, root+`\`)
}

// retry to'xtatilgan xizmat jarayoni fayllarni qo'yib yuborguncha (fileRetry) qayta urinadi.
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

// writeAtomic himoyalangan katalog ichida vaqtinchalik fayl + rename: yangi fayl katalog DACL'ini meros oladi,
// eski nom almashtiriladi.
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
	return copyStream(src, dst)
}

// copyTree yoyilgan paketni (staged) Companion katalogiga nusxalaydi: SkipInCompanionCopy fayllari va reparse
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
		if rel == "." {
			return nil
		}
		if d.Type()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.Mkdir(target, 0o755)
		}
		if SkipInCompanionCopy(rel) {
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
