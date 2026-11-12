// Package layout helper va Companion fayllarining Windows'dagi joylashuvi. Yo'llar Known Folders'dan olingan
// ildizlardan yasaladi (muhit o'zgaruvchilariga ishonilmaydi). `install` va xizmat (`run`) bir xil jadvaldan
// foydalanadi. Toza: har OS'da test qilinadi, shuning uchun ajratuvchi doim `\`.
package layout

import "strings"

// CompanionExe Companion paketidagi exe nomi (apps/companion/scripts/pack-win.mjs `EXE`).
const CompanionExe = "NetSchool Companion.exe"

// HelperExe helper binary'sining o'rnatilgan nomi.
const HelperExe = "netschool-helper.exe"

// Paths helper ishlatadigan hamma yo'l.
//
//   - `%ProgramFiles%\NetSchool\{helper,companion}` — o'rnatilgan dasturlar (faqat SYSTEM/Administrators yozadi);
//   - `%ProgramData%\NetSchool\helper\` — helper ma'lumoti (faqat SYSTEM/Administrators, o'qish ham): device.json,
//     hub-ca.pem, helper.key, lock.json, policy-journal.json, cad-journal.json;
//   - `%ProgramData%\NetSchool\companion\` — Companion `enroll` yozadigan katalog (install undan nusxa oladi).
type Paths struct {
	InstallRoot, HelperDir, HelperExe, CompanionDir, CompanionExe string

	DataRoot, HelperData                                          string
	DeviceJSON, HubCA, HelperKey, Lock, PolicyJournal, CADJournal string
	// HelperKeyPending `helper-key` yangi kalitni shu yerga yozadi; hub claim'ni qabul qilgach `set-hub` uni
	// helper.key o'rniga qo'yadi (claim yiqilsa ishlayotgan kalit buzilmaydi).
	HelperKeyPending string

	EnrollDir string

	Explorer string
}

func join(base string, parts ...string) string {
	return strings.Join(append([]string{strings.TrimRight(base, `\`)}, parts...), `\`)
}

// New programFiles, programData va windowsDir (FOLDERID_ProgramFiles, FOLDERID_ProgramData, FOLDERID_Windows)
// ildizlaridan yo'llarni yasaydi.
func New(programFiles, programData, windowsDir string) Paths {
	root := join(programFiles, "NetSchool")
	dataRoot := join(programData, "NetSchool")
	data := join(dataRoot, "helper")
	return Paths{
		InstallRoot:      root,
		HelperDir:        join(root, "helper"),
		HelperExe:        join(root, "helper", HelperExe),
		CompanionDir:     join(root, "companion"),
		CompanionExe:     join(root, "companion", CompanionExe),
		DataRoot:         dataRoot,
		HelperData:       data,
		DeviceJSON:       join(data, "device.json"),
		HubCA:            join(data, "hub-ca.pem"),
		HelperKey:        join(data, "helper.key"),
		HelperKeyPending: join(data, "helper.key.pending"),
		Lock:             join(data, "lock.json"),
		PolicyJournal:    join(data, "policy-journal.json"),
		CADJournal:       join(data, "cad-journal.json"),
		EnrollDir:        join(dataRoot, "companion"),
		Explorer:         join(windowsDir, "explorer.exe"),
	}
}
