//go:build windows

package fsacl

import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Hamma amal handle orqali: har element FILE_FLAG_OPEN_REPARSE_POINT bilan ochiladi (junction/symlink kuzatilmaydi),
// turi, reparse belgisi va hard link soni ochilgan handle'dan o'qiladi, ega va DACL SetSecurityInfo bilan shu
// handle'ga qo'yiladi (SetNamedSecurityInfo emas: u yo'lni qayta ochadi va merosni bolalarga o'zi yoyadi).
//
// Tekshiruv va ACL handle'lari DELETE'siz va hamma share bayroqlari bilan ochiladi (begona ochiq handle hardening'ni
// to'smaydi). Ishonchli katalogni oddiy foydalanuvchi qayta nomlay olmaydi (ota katalog va o'zining DACL'i), shuning
// uchun uning bolalari yo'l orqali ochiladi. Ishonchsiz katalog o'chirilayotganda DELETE bilan FILE_SHARE_DELETE'siz
// ochiq turadi (almashtirib bo'lmaydi) va file ID bilan tekshirilgan obyektning o'zi ekani solishtiriladi.

const (
	secureAccess  = windows.READ_CONTROL | windows.WRITE_DAC | windows.WRITE_OWNER
	shareNoDelete = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE
	shareAll      = shareNoDelete | windows.FILE_SHARE_DELETE
	openFlags     = windows.FILE_FLAG_OPEN_REPARSE_POINT | windows.FILE_FLAG_BACKUP_SEMANTICS
)

type entry struct {
	h    windows.Handle
	info windows.ByHandleFileInformation
}

func (e entry) isDir() bool { return e.info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 }
func (e entry) isReparse() bool {
	return e.info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// unsafeToTouch reparse point yoki bir nechta nomli fayl: ACL qo'yilsa u boshqa joydagi obyektga tushardi.
func (e entry) unsafeToTouch() bool { return e.isReparse() || (!e.isDir() && e.info.NumberOfLinks > 1) }

func (e entry) close() { _ = windows.CloseHandle(e.h) }

// fileID obyektning tom ichidagi o'zgarmas identifikatori (yo'l o'zgarsa ham, almashtirilsa farq qiladi).
type fileID struct{ volume, high, low uint32 }

func (e entry) id() fileID {
	return fileID{e.info.VolumeSerialNumber, e.info.FileIndexHigh, e.info.FileIndexLow}
}

// open path'ni o'zini (havolani kuzatmasdan) ochadi. SeBackup/SeRestore yoqilgan bo'lsa begona DACL ham
// to'smaydi (FILE_FLAG_BACKUP_SEMANTICS).
func open(path string, access uint32, share uint32) (entry, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return entry{}, err
	}
	h, err := windows.CreateFile(p, access, share, nil, windows.OPEN_EXISTING, openFlags, 0)
	if err != nil {
		return entry{}, &os.PathError{Op: "open", Path: path, Err: err}
	}
	e := entry{h: h}
	if err := windows.GetFileInformationByHandle(h, &e.info); err != nil {
		e.close()
		return entry{}, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	return e, nil
}

// Harden dir katalogini va ichidagi hamma narsani rule bo'yicha himoyalaydi. Ota katalog chaqiruvchi tomonidan
// oldin himoyalangan bo'lishi kerak.
//
// trusted — o'zgartirishdan OLDINGI holat: katalog bor edi, reparse point emas edi, egasi Administrators yoki SYSTEM
// va DACL himoyalangan edi (oddiy foydalanuvchi egani Administrators'ga o'zgartira olmaydi).
//   - trusted: katalog va har bola handle orqali qayta o'rnatiladi; reparse point'lar va hard link'li fayllar
//     o'chiriladi (havolaning o'zi, nishoni emas);
//   - aks holda: ichidagilar joyida ACL qilinmaydi — havolalarni kuzatmasdan o'chiriladi, katalog o'chiriladi va
//     himoyalangan DACL bilan yangidan yaratiladi (eski katalogga ochilgan begona handle'lar ham kuchsiz qoladi).
func Harden(dir string, rule Rule) (trusted bool, err error) {
	defer enablePrivileges()()
	return secure(dir, rule, true)
}

// HardenDir Harden kabi, lekin ishonchli katalogning faqat o'zini qayta o'rnatadi (bolalariga boshqa qoida
// qo'llanadi). Ishonchsiz katalog baribir tozalanib, yangidan yaratiladi.
func HardenDir(dir string, rule Rule) (trusted bool, err error) {
	defer enablePrivileges()()
	return secure(dir, rule, false)
}

// HardenHelperData xizmat har ishga tushishda (konfiguratsiyani o'qishdan oldin), install, helper-key va set-hub
// chaqiradi: avval dataRoot (`%ProgramData%\NetSchool`, faqat o'zi; foydalanuvchilar o'qiydi), keyin helperData
// (hamma ichidagisi bilan; faqat SYSTEM/Administrators). Tartib muhim: ota katalog himoyalangach o'quvchi helper
// katalogini almashtira olmaydi. trusted — helperData'niki (Harden).
func HardenHelperData(dataRoot, helperData string) (trusted bool, err error) {
	defer enablePrivileges()()
	// Mustaqil: ota katalog yiqilsa ham helper katalogi himoyalanadi (xatolar birlashtiriladi).
	_, rootErr := secure(dataRoot, Readable, false)
	trusted, dataErr := secure(helperData, Private, true)
	return trusted, errors.Join(rootErr, dataErr)
}

// RemoveTree path'ni havolalarni kuzatmasdan o'chiradi (reparse point'ning o'zi o'chadi, nishoni emas). Yo'q bo'lsa
// xato emas.
func RemoveTree(path string) error {
	defer enablePrivileges()()
	return removeTree(path)
}

// FreshDir path'ni (bo'lsa) RemoveTree bilan o'chiradi va rule.Dir DACL'i bilan yangidan yaratadi.
func FreshDir(path string, rule Rule) error {
	defer enablePrivileges()()
	if err := removeTree(path); err != nil {
		return err
	}
	return create(path, rule.Dir)
}

func secure(dir string, rule Rule, recurse bool) (trusted bool, err error) {
	// Tekshiruv va ACL uchun DELETE'siz va hamma share bayroqlari bilan: o'quvchi o'z katalogiga ochiq handle tutib
	// turib hardening'ni to'sa olmasin. DELETE faqat ishonchsiz/reparse yo'lida, egalik tekshiruvidan keyin.
	e, err := open(dir, secureAccess, shareAll)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return false, create(dir, rule.Dir)
	}
	if err != nil {
		return false, err
	}
	if e.isReparse() || !e.isDir() || !isTrusted(e.h) {
		id := e.id()
		e.close()
		return false, replace(dir, rule, id)
	}
	defer e.close()
	if err := apply(e.h, dir, rule.Dir); err != nil {
		return true, err
	}
	if !recurse {
		return true, nil
	}
	return true, secureChildren(dir, rule)
}

// replace ishonchsiz katalogni (yoki uning o'rnidagi havola/faylni) o'chiradi va yangidan yaratadi. DELETE bilan
// FILE_SHARE_DELETE'siz qayta ochiladi (ichidagilar o'chirilguncha katalogni almashtirib bo'lmaydi) va bu tekshirilgan
// obyektning o'zi ekani file ID bilan solishtiriladi. Ichidagilar joyida ACL qilinmaydi, havolalar kuzatilmaydi.
func replace(dir string, rule Rule, want fileID) error {
	e, err := open(dir, windows.DELETE|windows.READ_CONTROL, shareNoDelete)
	if err != nil {
		return fmt.Errorf("ishonchsiz %s o'chirish uchun ochilmadi: %w", dir, err)
	}
	if e.id() != want {
		e.close()
		return fmt.Errorf("%s tekshiruv paytida almashtirildi", dir)
	}
	if e.isDir() && !e.isReparse() {
		err = removeChildren(dir)
	}
	if err == nil {
		err = deleteHandle(e.h, dir)
	}
	e.close()
	if err != nil {
		return fmt.Errorf("ishonchsiz %s tozalanmadi: %w", dir, err)
	}
	return create(dir, rule.Dir)
}

// IsTrustedDir dir hozir ishonchli katalogmi: reparse point emas, egasi Administrators yoki SYSTEM, DACL
// himoyalangan. Xizmat konfiguratsiyani faqat shunday katalogdan o'qiydi.
func IsTrustedDir(dir string) (bool, error) {
	defer enablePrivileges()()
	e, err := open(dir, windows.READ_CONTROL, shareAll)
	if err != nil {
		return false, err
	}
	defer e.close()
	return e.isDir() && !e.isReparse() && isTrusted(e.h), nil
}

// secureChildren ishonchli katalog bolalarini handle orqali qayta o'rnatadi. Har bola mustaqil: xatolar
// birlashtiriladi.
func secureChildren(dir string, rule Rule) error {
	names, err := readNames(dir)
	if err != nil {
		return err
	}
	var errs []error
	for _, name := range names {
		path := dir + `\` + name
		e, err := open(path, secureAccess, shareAll)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if e.unsafeToTouch() {
			e.close()
			errs = append(errs, removeTree(path))
			continue
		}
		if e.isDir() {
			errs = append(errs, apply(e.h, path, rule.Dir), secureChildren(path, rule))
		} else {
			errs = append(errs, apply(e.h, path, rule.File))
		}
		e.close()
	}
	return errors.Join(errs...)
}

func removeTree(path string) error {
	e, err := open(path, windows.DELETE|windows.READ_CONTROL, shareNoDelete)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return nil
	}
	if err != nil {
		return err
	}
	defer e.close()
	if e.isDir() && !e.isReparse() {
		if err := removeChildren(path); err != nil {
			return err
		}
	}
	return deleteHandle(e.h, path)
}

func removeChildren(dir string) error {
	names, err := readNames(dir)
	if err != nil {
		return err
	}
	var errs []error
	for _, name := range names {
		errs = append(errs, removeTree(dir+`\`+name))
	}
	return errors.Join(errs...)
}

// readNames katalogdagi nomlar. Go katalogni FILE_FLAG_BACKUP_SEMANTICS bilan ochadi: SeBackup bilan begona DACL
// ro'yxatni yopa olmaydi. Katalogning o'zi chaqiruvchida FILE_SHARE_DELETE'siz ochiq (almashtirib bo'lmaydi).
func readNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdirnames(-1)
}

type fileDispositionInfoEx struct{ Flags uint32 }

// deleteHandle handle'dagi obyektni o'chiradi (reparse point'da havolaning o'zi). POSIX semantikasi: nom darhol
// yo'qoladi va o'sha nom bilan yangi katalog yaratish mumkin. Eski Windows'da oddiy disposition.
func deleteHandle(h windows.Handle, path string) error {
	info := fileDispositionInfoEx{Flags: windows.FILE_DISPOSITION_DELETE | windows.FILE_DISPOSITION_POSIX_SEMANTICS |
		windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE}
	err := windows.SetFileInformationByHandle(h, windows.FileDispositionInfoEx,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err == nil {
		return nil
	}
	del := byte(1)
	if err2 := windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, &del, 1); err2 != nil {
		return fmt.Errorf("%s o'chirilmadi: %w", path, errors.Join(err, err2))
	}
	return nil
}

// create katalogni sddl xavfsizlik deskriptori bilan yaratadi (ega va himoyalangan DACL yaratilish paytida).
func create(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("SDDL %q: %w", sddl, err)
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	if err := windows.CreateDirectory(p, &sa); err != nil {
		return fmt.Errorf("%s yaratilmadi: %w", path, err)
	}
	return nil
}

// isTrusted handle egasi Administrators yoki SYSTEM va DACL'i himoyalanganmi.
func isTrusted(h windows.Handle) bool {
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT,
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

// apply ega va himoyalangan DACL'ni handle'ga qo'yadi. SetSecurityInfo merosni bolalarga yoymaydi: har bola
// alohida tekshirilib, alohida o'rnatiladi.
func apply(h windows.Handle, path, sddl string) error {
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
	if err := windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, dacl, nil); err != nil {
		return fmt.Errorf("%s ACL o'rnatilmadi: %w", path, err)
	}
	return nil
}

var privilegeNames = []string{"SeBackupPrivilege", "SeRestorePrivilege", "SeTakeOwnershipPrivilege"}

// enablePrivileges SeBackup, SeRestore va SeTakeOwnership'ni yoqadi (administrator va SYSTEM tokenida bor, odatda
// o'chiq) va ularni oldingi holatiga qaytaradigan funksiyani qaytaradi. Yoqilmasa ham davom etiladi: keyingi xato
// sababini aytadi.
func enablePrivileges() (restore func()) {
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &tok); err != nil {
		return func() {}
	}
	var previous []windows.Tokenprivileges
	for _, name := range privilegeNames {
		var luid windows.LUID
		if err := windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(name), &luid); err != nil {
			continue
		}
		tp := windows.Tokenprivileges{PrivilegeCount: 1}
		tp.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
		var prev windows.Tokenprivileges
		var n uint32
		if err := windows.AdjustTokenPrivileges(tok, false, &tp, uint32(unsafe.Sizeof(prev)), &prev, &n); err == nil {
			previous = append(previous, prev)
		}
	}
	return func() {
		for i := len(previous) - 1; i >= 0; i-- {
			// PrivilegeCount 0 — o'zgarmagan edi (allaqachon yoqilgan yoki tokenda yo'q).
			if previous[i].PrivilegeCount > 0 {
				_ = windows.AdjustTokenPrivileges(tok, false, &previous[i], 0, nil, nil)
			}
		}
		_ = tok.Close()
	}
}
