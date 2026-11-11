// Package fsacl helper kataloglarining egasi va himoyalangan DACL'ini o'rnatadi (Windows: fsacl_windows.go).
// `install` ham, xizmat (`run`) ham har ishga tushishda bir xil qoidani qo'llaydi: ProgramData'da oddiy
// foydalanuvchi katalogni helper'dan oldin yaratib, unga o'z fayllarini qo'yishi mumkin.
package fsacl

// Rule katalog va uning ichidagi fayllar uchun SDDL. Egasi BUILTIN\Administrators, DACL himoyalangan (P: ota
// katalogdan meros olinmaydi), shuning uchun ProgramData'ning "Users: yozish" merosi tushib qoladi.
type Rule struct {
	Dir  string // katalog: OICI — ichida yangi yaratilgan fayl va kataloglar shu ACE'larni meros oladi
	File string // mavjud fayllar (ACE'da meros bayrog'i yo'q)
}

// Private helper ma'lumot katalogi (`%ProgramData%\NetSchool\helper`): faqat SYSTEM va Administrators, o'qish ham.
var Private = Rule{
	Dir:  "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
	File: "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)",
}

// Readable `%ProgramFiles%\NetSchool`, `%ProgramData%\NetSchool` va Companion enrollment katalogi: SYSTEM va
// Administrators to'liq, Users faqat o'qish va ishga tushirish (0x1200a9 = FILE_GENERIC_READ | FILE_EXECUTE).
// Companion oddiy foydalanuvchi sessiyasida ishlaydi va o'z exe'si hamda enrollment'ini o'qishi kerak.
var Readable = Rule{
	Dir:  "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)",
	File: "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)",
}

// DataResult HardenHelperData natijasi.
type DataResult struct {
	// RootReplaced `%ProgramData%\NetSchool` bor edi, lekin ishonchsiz edi (masalan, P0c paketi yoki o'quvchi
	// yaratgan, meros DACL'li) va butunlay o'chirib yangidan yaratildi: ichidagi Companion enrollment'i
	// (`companion\device.json`, `device.key`) ham yo'qoldi — kompyuter yangi token bilan qayta ro'yxatdan o'tkaziladi.
	RootReplaced bool
	// HelperTrusted helper katalogi oldin ham ishonchli edi (Harden'dagi trusted).
	HelperTrusted bool
}

// RootReplacedWarning RootReplaced bo'lganda helper-key va install chiqaradigan ogohlantirish.
const RootReplacedWarning = "ogohlantirish: %ProgramData%\\NetSchool ishonchsiz edi (eski P0c paketi yoki begona katalog) va " +
	"butunlay o'chirib qayta yaratildi; undagi Companion ro'yxatdan o'tishi ham o'chdi. Kompyuterni yangi token bilan " +
	"`enroll.cmd --force` orqali qayta ro'yxatdan o'tkazing (faqat install.cmd yetmaydi)"
