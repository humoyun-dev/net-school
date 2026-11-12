//go:build windows

package fsacl

import (
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Hamma amal handle orqali:
//   - yuqori darajadagi katalog (dataRoot, helperData, staging) CreateFile + FILE_FLAG_OPEN_REPARSE_POINT bilan
//     ochiladi; uning ota katalogi oldin tekshirilgan (dataRoot'ning otasi — tizim ProgramData'si);
//   - bolalar ro'yxati qadalgan (pinned) katalog handle'idan GetFileInformationByHandleEx(FileIdBothDirectoryInfo)
//     bilan olinadi, har bola esa NtCreateFile bilan shu handle'ga NISBATAN (RootDirectory) ochiladi va
//     FILE_OPEN_REPARSE_POINT bilan: yo'l qayta tahlil qilinmaydi, junction kuzatilmaydi;
//   - turi, reparse belgisi va hard link soni ochilgan handle'dan o'qiladi;
//   - ega va DACL SetKernelObjectSecurity bilan handle'ga qo'yiladi. U (SetSecurityInfo/SetNamedSecurityInfo'dan
//     farqli) merosni bolalarga YOYMAYDI: har bola alohida tekshirilib, alohida o'rnatiladi.
//
// Tekshiruv handle'i DELETE'siz va hamma share bayroqlari bilan ochiladi: begona ochiq handle tekshiruvni to'smaydi.
// Ishonchli katalog aylanib chiqilayotganda (yoki ishonchsiz katalog o'chirilayotganda) u FILE_SHARE_DELETE'siz
// qadalgan turadi: na uni, na ota kataloglarini qayta nomlab, o'rniga junction qo'yib bo'lmaydi. Qayta ochilgan
// handle tekshirilgan obyektning o'zi ekani file ID bilan solishtiriladi.

const (
	secureAccess  = windows.READ_CONTROL | windows.WRITE_DAC | windows.WRITE_OWNER
	listAccess    = windows.FILE_LIST_DIRECTORY | windows.SYNCHRONIZE
	shareNoDelete = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE
	shareAll      = shareNoDelete | windows.FILE_SHARE_DELETE
	openFlags     = windows.FILE_FLAG_OPEN_REPARSE_POINT | windows.FILE_FLAG_BACKUP_SEMANTICS
	// metaAccess har handle'ga qo'shiladi: GetFileInformationByHandle FILE_READ_ATTRIBUTES talab qiladi, sinxron
	// so'rovlar (FILE_SYNCHRONOUS_IO_NONALERT, ro'yxat) SYNCHRONIZE. CreateFileW ularni o'zi qo'shadi, xom
	// NtCreateFile esa yo'q. Ular ma'lumotga kirish emas: share rejimi ularni to'smaydi.
	metaAccess = windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE
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

// fileID obyektning tom ichidagi o'zgarmas identifikatori (almashtirilgan obyektda farq qiladi).
type fileID struct{ volume, high, low uint32 }

func (e entry) id() fileID {
	return fileID{e.info.VolumeSerialNumber, e.info.FileIndexHigh, e.info.FileIndexLow}
}

func stat(h windows.Handle) (entry, error) {
	e := entry{h: h}
	if err := windows.GetFileInformationByHandle(h, &e.info); err != nil {
		e.close()
		return entry{}, err
	}
	return e, nil
}

// open yuqori darajadagi path'ni o'zini (havolani kuzatmasdan) ochadi. SeBackup/SeRestore yoqilgan bo'lsa begona
// DACL ham to'smaydi (FILE_FLAG_BACKUP_SEMANTICS). CreateFile handle'i sinxron (ro'yxat olish uchun kerak).
func open(path string, access uint32, share uint32) (entry, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return entry{}, err
	}
	h, err := windows.CreateFile(p, access|metaAccess, share, nil, windows.OPEN_EXISTING, openFlags, 0)
	if err != nil {
		return entry{}, fmt.Errorf("%s ochilmadi: %w", path, err)
	}
	e, err := stat(h)
	if err != nil {
		return entry{}, fmt.Errorf("%s: %w", path, err)
	}
	return e, nil
}

// errGone bola ro'yxat olingandan keyin yo'qoldi.
var errGone = errors.New("yo'q")

// openAt dir handle'iga nisbatan name'ni ochadi (yo'l qayta tahlil qilinmaydi, reparse point kuzatilmaydi).
func openAt(dir windows.Handle, name string, access, share uint32) (entry, error) {
	us, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return entry{}, err
	}
	oa := windows.OBJECT_ATTRIBUTES{RootDirectory: dir, ObjectName: us}
	oa.Length = uint32(unsafe.Sizeof(oa))
	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&h, access|metaAccess, &oa, &iosb, nil, 0, share, windows.FILE_OPEN,
		windows.FILE_OPEN_REPARSE_POINT|windows.FILE_OPEN_FOR_BACKUP_INTENT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if errors.Is(err, windows.STATUS_OBJECT_NAME_NOT_FOUND) {
		return entry{}, errGone
	}
	if err != nil {
		return entry{}, fmt.Errorf("%s ochilmadi: %w", name, err)
	}
	return stat(h)
}

// listNames qadalgan katalog handle'idan bolalar nomlari (`.` va `..`siz).
func listNames(dir windows.Handle) ([]string, error) {
	const (
		fileIDBothDirectoryInfo        = windows.FileIdBothDirectoryInfo
		fileIDBothDirectoryRestartInfo = 11
		nameLengthOffset               = 60
		nameOffset                     = 104
	)
	// NtQueryDirectoryFile buferni 8 baytga tekislangan bo'lishini talab qiladi (aks holda ERROR_NOACCESS).
	// []byte'ning tekislanishi 1 (kompilyator uni stekka ham qo'yishi mumkin), shuning uchun []uint64 ustida.
	words := make([]uint64, (64<<10)/8)
	buf := unsafe.Slice((*byte)(unsafe.Pointer(&words[0])), len(words)*8)
	class := uint32(fileIDBothDirectoryRestartInfo)
	var names []string
	for {
		err := windows.GetFileInformationByHandleEx(dir, class, &buf[0], uint32(len(buf)))
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return names, nil
		}
		if err != nil {
			return nil, fmt.Errorf("katalog ro'yxati olinmadi: %w", err)
		}
		class = fileIDBothDirectoryInfo
		for off := 0; ; {
			if off+nameOffset > len(buf) {
				return nil, errors.New("katalog ro'yxati buzilgan")
			}
			next := binary.LittleEndian.Uint32(buf[off:])
			n := int(binary.LittleEndian.Uint32(buf[off+nameLengthOffset:]))
			if off+nameOffset+n > len(buf) {
				return nil, errors.New("katalog ro'yxati buzilgan")
			}
			u := make([]uint16, n/2)
			for i := range u {
				u[i] = binary.LittleEndian.Uint16(buf[off+nameOffset+2*i:])
			}
			if name := string(utf16.Decode(u)); name != "." && name != ".." {
				names = append(names, name)
			}
			if next == 0 {
				break
			}
			off += int(next)
		}
	}
}

// Harden dir katalogini va ichidagi hamma narsani rule bo'yicha himoyalaydi. Ota katalog chaqiruvchi tomonidan
// oldin himoyalangan va tekshirilgan bo'lishi kerak.
//
// trusted — o'zgartirishdan OLDINGI holat: katalog bor edi, reparse point emas edi, egasi Administrators yoki SYSTEM
// va DACL himoyalangan edi (oddiy foydalanuvchi egani Administrators'ga o'zgartira olmaydi).
//   - trusted: katalog va har bola handle orqali qayta o'rnatiladi; reparse point'lar va hard link'li fayllar
//     o'chiriladi (havolaning o'zi, nishoni emas);
//   - aks holda: ichidagilar joyida ACL qilinmaydi — havolalarni kuzatmasdan o'chiriladi, katalog o'chiriladi va
//     himoyalangan DACL bilan yangidan yaratiladi (eski katalogga ochilgan begona handle'lar ham kuchsiz qoladi).
func Harden(dir string, rule Rule) (trusted bool, err error) {
	defer enablePrivileges()()
	st, err := secure(dir, rule, true)
	return st == stateTrusted, err
}

// HardenDir Harden kabi, lekin ishonchli katalogning faqat o'zini qayta o'rnatadi (bolalariga boshqa qoida
// qo'llanadi). Ishonchsiz katalog baribir tozalanib, yangidan yaratiladi.
func HardenDir(dir string, rule Rule) (trusted bool, err error) {
	defer enablePrivileges()()
	st, err := secure(dir, rule, false)
	return st == stateTrusted, err
}

// HardenHelperData xizmat (ishga tushishda va tekshirilmagan bo'lsa davriy), install, helper-key va set-hub
// chaqiradi: avval dataRoot (`%ProgramData%\NetSchool`, faqat o'zi; foydalanuvchilar o'qiydi), keyin helperData
// (hamma ichidagisi bilan; faqat SYSTEM/Administrators). dataRoot himoyalanmasa yoki undan keyin ham ishonchli
// bo'lmasa helperData'ga umuman tegilmaydi va xato qaytariladi: o'quvchi egalik qilayotgan ota katalogda u helper
// katalogini aylanib chiqish paytida almashtirishi mumkin edi. RootReplaced xato bo'lsa ham to'g'ri (o'chirish
// bo'lib o'tgan bo'lishi mumkin).
func HardenHelperData(dataRoot, helperData string) (DataResult, error) {
	defer enablePrivileges()()
	var res DataResult
	st, err := secure(dataRoot, Readable, false)
	res.RootReplaced = st == stateReplaced
	if err != nil {
		return res, fmt.Errorf("%s himoyalanmadi: %w", dataRoot, err)
	}
	if ok, err := isTrustedDir(dataRoot); err != nil || !ok {
		return res, fmt.Errorf("%s himoyalangandan keyin ham ishonchli emas (%v)", dataRoot, err)
	}
	st, err = secure(helperData, Private, true)
	res.HelperTrusted = st == stateTrusted
	return res, err
}

// RemoveTree path'ni havolalarni kuzatmasdan o'chiradi (reparse point'ning o'zi o'chadi, nishoni emas). Yo'q bo'lsa
// xato emas.
func RemoveTree(path string) error {
	defer enablePrivileges()()
	e, err := open(path, windows.DELETE|windows.READ_CONTROL|listAccess, shareNoDelete)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return nil
	}
	if err != nil {
		return err
	}
	defer e.close()
	return removeEntry(e, path)
}

// FreshDir path'ni (bo'lsa) RemoveTree bilan o'chiradi va rule.Dir DACL'i bilan yangidan yaratadi.
func FreshDir(path string, rule Rule) error {
	if err := RemoveTree(path); err != nil {
		return err
	}
	defer enablePrivileges()()
	return create(path, rule.Dir)
}

// IsTrustedDir dir hozir ishonchli katalogmi: reparse point emas, egasi Administrators yoki SYSTEM, DACL
// himoyalangan. Xizmat konfiguratsiyani faqat shunday katalogdan o'qiydi.
func IsTrustedDir(dir string) (bool, error) {
	defer enablePrivileges()()
	return isTrustedDir(dir)
}

func isTrustedDir(dir string) (bool, error) {
	e, err := open(dir, windows.READ_CONTROL, shareAll)
	if err != nil {
		return false, err
	}
	defer e.close()
	return e.isDir() && !e.isReparse() && isTrusted(e.h), nil
}

// dirState secure'dan OLDINGI holat.
type dirState int

const (
	stateCreated  dirState = iota // katalog yo'q edi (yoki tekshiruv yiqildi), yangidan yaratildi
	stateReplaced                 // bor edi, ishonchsiz edi: ichidagilari bilan o'chirib yangidan yaratildi
	stateTrusted                  // bor edi va ishonchli edi: joyida qayta o'rnatildi
)

func secure(dir string, rule Rule, recurse bool) (dirState, error) {
	// Tekshiruv: DELETE'siz, hamma share bayroqlari bilan (o'quvchi o'z katalogiga ochiq handle tutib turib uni
	// to'sa olmasin).
	e, err := open(dir, windows.READ_CONTROL, shareAll)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		return stateCreated, create(dir, rule.Dir)
	}
	if err != nil {
		return stateCreated, err
	}
	id, ok := e.id(), e.isDir() && !e.isReparse() && isTrusted(e.h)
	e.close()
	if !ok {
		return stateReplaced, replace(dir, rule, id)
	}
	if !recurse {
		// Faqat katalogning o'zi (dataRoot): bolalarni aylanib chiqmaymiz, shuning uchun qadash shart emas.
		// Faqat metadata huquqlari (ma'lumotga kirish yo'q) va hamma share bayroqlari: o'quvchi o'qiy oladigan
		// `%ProgramData%\NetSchool`ga share 0 bilan handle tutib turib uni to'sa olmaydi (aks holda helper tekshirilmay,
		// hub'siz va ochiq qolardi). Ishonchli root'da oddiy foydalanuvchida DELETE/FILE_DELETE_CHILD yo'q, ya'ni uni
		// almashtira olmaydi. Ishonchsiz root esa (yuqorida) DELETE bilan almashtiriladi va to'silsa xato bilan
		// to'xtaydi: install buni administratorga ko'rsatadi.
		e, err := open(dir, secureAccess, shareAll)
		if err != nil {
			return stateTrusted, err
		}
		defer e.close()
		if e.id() != id {
			return stateTrusted, fmt.Errorf("%s tekshiruv paytida almashtirildi", dir)
		}
		return stateTrusted, apply(e.h, dir, rule.Dir)
	}
	// Ishonchli: FILE_SHARE_DELETE'siz qadaladi (oddiy foydalanuvchida bu katalogga DELETE yo'q, shuning uchun bu
	// ochish begona handle tufayli yiqilmaydi) va aylanib chiqish shu handle orqali.
	p, err := open(dir, secureAccess|listAccess, shareNoDelete)
	if err != nil {
		return stateTrusted, err
	}
	defer p.close()
	if p.id() != id {
		return stateTrusted, fmt.Errorf("%s tekshiruv paytida almashtirildi", dir)
	}
	if err := apply(p.h, dir, rule.Dir); err != nil {
		return stateTrusted, err
	}
	return stateTrusted, secureChildren(p.h, dir, rule)
}

// replace ishonchsiz katalogni (yoki uning o'rnidagi havola/faylni) o'chiradi va yangidan yaratadi. DELETE bilan
// FILE_SHARE_DELETE'siz qayta ochiladi va bu tekshirilgan obyektning o'zi ekani file ID bilan solishtiriladi.
// Ichidagilar joyida ACL qilinmaydi, havolalar kuzatilmaydi.
func replace(dir string, rule Rule, want fileID) error {
	e, err := open(dir, windows.DELETE|windows.READ_CONTROL|listAccess, shareNoDelete)
	if err != nil {
		return fmt.Errorf("ishonchsiz %s o'chirish uchun ochilmadi: %w", dir, err)
	}
	if e.id() != want {
		e.close()
		return fmt.Errorf("%s tekshiruv paytida almashtirildi", dir)
	}
	err = removeEntry(e, dir)
	e.close()
	if err != nil {
		return fmt.Errorf("ishonchsiz %s tozalanmadi: %w", dir, err)
	}
	return create(dir, rule.Dir)
}

// secureChildren qadalgan ishonchli katalog bolalarini handle orqali qayta o'rnatadi. Har bola mustaqil: xatolar
// birlashtiriladi.
func secureChildren(dir windows.Handle, path string, rule Rule) error {
	names, err := listNames(dir)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	var errs []error
	for _, name := range names {
		child := path + `\` + name
		e, err := openAt(dir, name, windows.READ_CONTROL, shareAll)
		if errors.Is(err, errGone) {
			continue
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		id, unsafeEntry, isDir := e.id(), e.unsafeToTouch(), e.isDir()
		e.close()
		if unsafeEntry {
			errs = append(errs, removeAt(dir, name, child))
			continue
		}
		access, share := uint32(secureAccess), uint32(shareAll)
		if isDir {
			access, share = secureAccess|listAccess, shareNoDelete
		}
		c, err := openAt(dir, name, access, share)
		if errors.Is(err, errGone) {
			continue
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		switch {
		case c.id() != id || c.unsafeToTouch():
			errs = append(errs, fmt.Errorf("%s tekshiruv paytida almashtirildi", child))
		case c.isDir():
			errs = append(errs, apply(c.h, child, rule.Dir), secureChildren(c.h, child, rule))
		default:
			errs = append(errs, apply(c.h, child, rule.File))
		}
		c.close()
	}
	return errors.Join(errs...)
}

// removeAt dir ichidagi name'ni (havolani kuzatmasdan) o'chiradi. Avval ma'lumotga kirishsiz ochiladi (fayl band
// bo'lsa ham share to'smasin); oddiy katalog bo'lsa ro'yxat uchun FILE_LIST_DIRECTORY bilan qayta ochiladi va
// file ID solishtiriladi.
func removeAt(dir windows.Handle, name, path string) error {
	e, err := openAt(dir, name, windows.DELETE|windows.READ_CONTROL, shareNoDelete)
	if errors.Is(err, errGone) {
		return nil
	}
	if err != nil {
		return err
	}
	if !e.isDir() || e.isReparse() {
		defer e.close()
		return deleteHandle(e.h, path)
	}
	id := e.id()
	e.close()
	d, err := openAt(dir, name, windows.DELETE|windows.READ_CONTROL|listAccess, shareNoDelete)
	if errors.Is(err, errGone) {
		return nil
	}
	if err != nil {
		return err
	}
	defer d.close()
	if d.id() != id || !d.isDir() || d.isReparse() {
		return fmt.Errorf("%s o'chirish paytida almashtirildi", path)
	}
	return removeEntry(d, path)
}

// removeEntry ochilgan obyektni o'chiradi: oddiy katalog bo'lsa avval bolalarini (shu handle orqali), reparse point
// bo'lsa faqat havolaning o'zini.
func removeEntry(e entry, path string) error {
	if e.isDir() && !e.isReparse() {
		names, err := listNames(e.h)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		var errs []error
		for _, name := range names {
			errs = append(errs, removeAt(e.h, name, path+`\`+name))
		}
		if err := errors.Join(errs...); err != nil {
			return err
		}
	}
	return deleteHandle(e.h, path)
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

// apply ega va himoyalangan DACL'ni (SDDL'dagi `P` — SE_DACL_PROTECTED) SetKernelObjectSecurity bilan handle'ga
// qo'yadi. U merosni bolalarga yoymaydi (SetSecurityInfo/SetNamedSecurityInfo yoyadi): bolalar faqat aniq aylanib
// chiqishda, har biri tekshirilgandan keyin o'rnatiladi.
func apply(h windows.Handle, path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("SDDL %q: %w", sddl, err)
	}
	if err := windows.SetKernelObjectSecurity(h,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION, sd); err != nil {
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
