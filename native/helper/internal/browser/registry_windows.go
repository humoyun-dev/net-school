//go:build windows

package browser

import (
	"errors"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type winRegistry struct {
	root   registry.Key
	prefix string
}

// NewRegistry HKLM'ning 64-bit ko'rinishi (32-bit qayta yo'naltirishsiz: brauzerlar 64-bit kalitni o'qiydi).
func NewRegistry() Registry { return winRegistry{root: registry.LOCAL_MACHINE} }

func (r winRegistry) path(key string) string {
	if r.prefix == "" {
		return key
	}
	return r.prefix + `\` + key
}

func notExist(err error) bool {
	return errors.Is(err, registry.ErrNotExist) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}

func (r winRegistry) Read(key, name string) (any, bool, error) {
	k, err := registry.OpenKey(r.root, r.path(key), registry.QUERY_VALUE|registry.WOW64_64KEY)
	if notExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer k.Close()
	_, typ, err := k.GetValue(name, nil)
	if notExist(err) {
		return nil, false, nil
	}
	if err != nil && !errors.Is(err, windows.ERROR_MORE_DATA) {
		return nil, false, err
	}
	switch typ {
	case registry.DWORD:
		v, _, err := k.GetIntegerValue(name)
		return uint32(v), err == nil, err
	case registry.SZ, registry.EXPAND_SZ:
		v, _, err := k.GetStringValue(name)
		return v, err == nil, err
	default:
		// Boshqa tur — mos emas deb hisoblanadi va qayta yoziladi.
		return nil, true, nil
	}
}

func (r winRegistry) Write(key, name string, v any) error {
	k, _, err := registry.CreateKey(r.root, r.path(key), registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	switch x := v.(type) {
	case uint32:
		return k.SetDWordValue(name, x)
	case string:
		return k.SetStringValue(name, x)
	default:
		return errors.New("browser: qo'llab-quvvatlanmagan qiymat turi")
	}
}

func (r winRegistry) Delete(key, name string) error {
	k, err := registry.OpenKey(r.root, r.path(key), registry.SET_VALUE|registry.WOW64_64KEY)
	if notExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(name); err != nil && !notExist(err) {
		return err
	}
	return nil
}

func (r winRegistry) Names(key string) ([]string, error) {
	k, err := registry.OpenKey(r.root, r.path(key), registry.QUERY_VALUE|registry.WOW64_64KEY)
	if notExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer k.Close()
	return k.ReadValueNames(0)
}
