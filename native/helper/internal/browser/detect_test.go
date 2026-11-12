package browser

import (
	"reflect"
	"testing"
)

func TestUnmanagedBrowsersDetected(t *testing.T) {
	got := Unmanaged([]string{
		`c:\program files\mozilla firefox\firefox.exe`,
		`c:\users\s\appdata\local\yandex\yandexbrowser\application\browser.exe`,
		`c:\program files\google\chrome\application\chrome.exe`,
		`c:\program files\mozilla firefox\firefox.exe`,
		`c:\windows\explorer.exe`,
	})
	if !reflect.DeepEqual(got, []string{"browser.exe", "firefox.exe"}) {
		t.Fatalf("got %v", got)
	}
}
