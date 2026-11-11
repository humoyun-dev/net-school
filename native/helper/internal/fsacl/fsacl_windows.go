//go:build windows

package fsacl

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// Harden dir katalogini (yo'q bo'lsa yaratadi) va uning ichidagi hamma narsani rule bo'yicha qayta o'rnatadi:
// egasi Administrators, himoyalangan DACL. Ichidagi reparse point'lar (junction, symlink) o'chiriladi: ular
// orqali ACL boshqa joyga qo'llanmasin va helper begona faylni o'qimasin. dir'ning o'zi reparse point bo'lsa,
// havola o'chirilib, o'rniga oddiy katalog yaratiladi.
//
// trusted — o'zgartirishdan OLDINGI holat: katalog bor edi, egasi Administrators yoki SYSTEM va DACL himoyalangan
// edi. Oddiy foydalanuvchi egani Administrators'ga o'zgartira olmaydi, shuning uchun bunday katalogni faqat
// administrator (yoki oldingi install) yaratgan. trusted=false katalogdagi fayllarga ishonib bo'lmaydi.
//
// Har element mustaqil: bittasi yiqilsa qolganlari baribir qayta o'rnatiladi, xatolar birlashtiriladi.
func Harden(dir string, rule Rule) (trusted bool, err error) {
	enablePrivileges()
	trusted, err = ensureDirTrusted(dir)
	if err != nil {
		return false, err
	}
	if err := apply(dir, rule.Dir); err != nil {
		return trusted, err
	}
	var errs []error
	walkErr := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if p == dir {
			return err
		}
		if err != nil {
			errs = append(errs, err)
			return nil
		}
		info, err := os.Lstat(p)
		if err != nil {
			errs = append(errs, err)
			return nil
		}
		if isReparse(info) {
			if err := os.Remove(p); err != nil {
				errs = append(errs, fmt.Errorf("%s reparse point, o'chirilmadi: %w", p, err))
			}
			if info.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		sddl := rule.File
		if info.IsDir() {
			sddl = rule.Dir
		}
		// Katalog ichiga kirishdan oldin (WalkDir uni keyin o'qiydi): begona DACL ro'yxatni yopgan bo'lishi mumkin.
		if err := apply(p, sddl); err != nil {
			errs = append(errs, err)
		}
		return nil
	})
	return trusted, errors.Join(append(errs, walkErr)...)
}

// HardenDir faqat dir'ning o'zini (ichidagilarsiz) qayta o'rnatadi; yo'q bo'lsa yaratadi, reparse point bo'lsa
// havolani o'chirib oddiy katalog yaratadi. Ota katalog uchun (`%ProgramData%\NetSchool`): ichidagi helper
// katalogiga boshqa qoida qo'llanadi.
func HardenDir(dir string, rule Rule) error {
	enablePrivileges()
	if err := ensureDir(dir); err != nil {
		return err
	}
	return apply(dir, rule.Dir)
}

func ensureDir(dir string) error {
	_, err := ensureDirTrusted(dir)
	return err
}

// ensureDirTrusted dir'ni oddiy katalog qiladi. trusted — oldin bor edi va bizniki edi (isTrusted).
func ensureDirTrusted(dir string) (trusted bool, err error) {
	info, err := os.Lstat(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return false, err
	case isReparse(info):
		if err := os.Remove(dir); err != nil {
			return false, fmt.Errorf("%s reparse point, o'chirilmadi: %w", dir, err)
		}
	case !info.IsDir():
		return false, fmt.Errorf("%s katalog emas", dir)
	default:
		trusted = isTrusted(dir)
	}
	return trusted, os.MkdirAll(dir, 0o700)
}

// HardenHelperData xizmat har ishga tushishda (konfiguratsiyani o'qishdan oldin) va install chaqiradi:
// dataRoot (`%ProgramData%\NetSchool`, faqat katalogning o'zi; foydalanuvchilar o'qiydi), keyin helperData
// (ichidagi hamma narsa bilan; faqat SYSTEM/Administrators). Tartib muhim: avval ota katalog — uni oldindan
// yaratgan o'quvchi helper katalogini almashtira olmasin. trusted — helperData o'zgartirishdan oldin bizniki
// edimi (Harden).
func HardenHelperData(dataRoot, helperData string) (trusted bool, err error) {
	rootErr := HardenDir(dataRoot, Readable)
	trusted, dataErr := Harden(helperData, Private)
	return trusted, errors.Join(rootErr, dataErr)
}

// Clear dir ichidagi hamma narsani o'chiradi (katalogning o'zi qoladi). Harden'dan keyin chaqiriladi: begona
// fayllarni o'chirish huquqi shunda bor.
func Clear(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		errs = append(errs, os.RemoveAll(filepath.Join(dir, e.Name())))
	}
	return errors.Join(errs...)
}

func isReparse(info fs.FileInfo) bool {
	if a, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return a.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
	}
	return info.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0
}

// isTrusted katalogning hozirgi egasi Administrators yoki SYSTEM va DACL'i himoyalanganmi.
func isTrusted(dir string) bool {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return false
	}
	if !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) && !owner.IsWellKnown(windows.WinLocalSystemSid) {
		return false
	}
	control, _, err := sd.Control()
	return err == nil && control&windows.SE_DACL_PROTECTED != 0
}

// apply avval egani (SeTakeOwnership/SeRestore bilan: begona DACL bizga WRITE_DAC bermasa ham), keyin
// himoyalangan DACL'ni o'rnatadi. Ikki alohida chaqiruv: egasi bo'lgach WRITE_DAC egalik huquqidan keladi.
func apply(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("SDDL %q: %w", sddl, err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION,
		owner, nil, nil, nil); err != nil {
		return fmt.Errorf("%s egasi o'rnatilmadi: %w", path, err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("%s DACL o'rnatilmadi: %w", path, err)
	}
	return nil
}

// enablePrivileges jarayon tokenida SeTakeOwnership va SeRestore'ni yoqadi (administrator va SYSTEM'da bor,
// lekin odatda o'chiq). Yoqilmasa ham davom etiladi: apply xatosi sababini aytadi.
func enablePrivileges() {
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &tok); err != nil {
		return
	}
	defer tok.Close()
	for _, name := range []string{"SeTakeOwnershipPrivilege", "SeRestorePrivilege"} {
		var luid windows.LUID
		if err := windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(name), &luid); err != nil {
			continue
		}
		tp := windows.Tokenprivileges{PrivilegeCount: 1}
		tp.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
		_ = windows.AdjustTokenPrivileges(tok, false, &tp, 0, nil, nil)
	}
}
