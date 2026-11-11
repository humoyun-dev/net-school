//go:build windows

package policy

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// errHiveNotLoaded foydalanuvchi hive'i (`HKU\<SID>`) hozir yuklanmagan (u tizimga kirmagan). Bu "qiymat yo'q"
// degani emas: qiymatlar diskdagi NTUSER.DAT'da turgan bo'lishi mumkin, shuning uchun Read/Write/Delete jimgina
// muvaffaqiyatli bo'lmaydi va Write HKU ostida begona kalit yaratib yubormaydi.
var errHiveNotLoaded = errors.New("foydalanuvchi hive'i yuklanmagan")

// systemRegistry Registry'ning haqiqiy Windows realizatsiyasi (`golang.org/x/sys/windows/registry`).
type systemRegistry struct{}

// NewRegistry haqiqiy reyestrga yozadigan Registry'ni qaytaradi. root: `HKLM` yoki `HKU\<SID>`, boshqasi xato.
func NewRegistry() Registry { return systemRegistry{} }

// resolve root'ni ildiz kalit va hive ichidagi to'liq yo'lga aylantiradi. HKU uchun hive yuklanganligi tekshiriladi
// (tekshiruv bilan foydalanish orasidagi juda qisqa oraliq: hive aynan shu paytda tushirilsa keyingi amal xato beradi
// yoki bo'sh kalit yaratadi; bloklash seansi davomida hive tushirilmaydi).
func resolve(root, key string) (base registry.Key, path string, err error) {
	hive, sid, err := parseRoot(root)
	if err != nil {
		return 0, "", err
	}
	if hive == hiveMachine {
		return registry.LOCAL_MACHINE, key, nil
	}
	h, err := registry.OpenKey(registry.USERS, sid, registry.QUERY_VALUE)
	if isNotExist(err) {
		return 0, "", fmt.Errorf("%w: %s", errHiveNotLoaded, sid)
	}
	if err != nil {
		return 0, "", fmt.Errorf("HKU\\%s ochilmadi: %w", sid, err)
	}
	h.Close()
	return registry.USERS, sid + `\` + key, nil
}

func isNotExist(err error) bool {
	return errors.Is(err, registry.ErrNotExist) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}

// Read qiymatni o'qiydi. Kalit yoki qiymat yo'q bo'lsa (nil, nil). REG_DWORD bo'lmagan qiymat xato: uni uint32
// sifatida saqlab, keyin aynan o'sha ko'rinishda qaytarib bo'lmaydi.
func (systemRegistry) Read(root, key, name string) (*uint32, error) {
	base, path, err := resolve(root, key)
	if err != nil {
		return nil, err
	}
	k, err := registry.OpenKey(base, path, registry.QUERY_VALUE)
	if isNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s\\%s ochilmadi: %w", root, key, err)
	}
	defer k.Close()
	v, typ, err := k.GetIntegerValue(name)
	if isNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s\\%s [%s] o'qilmadi: %w", root, key, name, err)
	}
	if typ != registry.DWORD {
		return nil, fmt.Errorf("%s\\%s [%s] REG_DWORD emas (tur %d)", root, key, name, typ)
	}
	out := uint32(v)
	return &out, nil
}

// Write REG_DWORD qiymatni yozadi; kalit (oraliq kalitlar bilan) yo'q bo'lsa yaratiladi.
func (systemRegistry) Write(root, key, name string, v uint32) error {
	base, path, err := resolve(root, key)
	if err != nil {
		return err
	}
	k, _, err := registry.CreateKey(base, path, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("%s\\%s ochilmadi: %w", root, key, err)
	}
	defer k.Close()
	if err := k.SetDWordValue(name, v); err != nil {
		return fmt.Errorf("%s\\%s [%s] yozilmadi: %w", root, key, name, err)
	}
	return nil
}

// Delete qiymatni o'chiradi; kalit yoki qiymat allaqachon yo'q bo'lsa xato emas. Kalitning o'zi qoldiriladi.
func (systemRegistry) Delete(root, key, name string) error {
	base, path, err := resolve(root, key)
	if err != nil {
		return err
	}
	k, err := registry.OpenKey(base, path, registry.SET_VALUE)
	if isNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%s\\%s ochilmadi: %w", root, key, err)
	}
	defer k.Close()
	if err := k.DeleteValue(name); err != nil && !isNotExist(err) {
		return fmt.Errorf("%s\\%s [%s] o'chirilmadi: %w", root, key, name, err)
	}
	return nil
}
