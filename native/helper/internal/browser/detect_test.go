package browser

import (
	"reflect"
	"testing"
)

func TestUnmanagedBrowsersDetected(t *testing.T) {
	got := Unmanaged(trusted, []string{
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

var trusted = []string{`c:\program files`, `c:\program files (x86)`}

func TestPortableChromeOutsideProgramFilesIsUnmanaged(t *testing.T) {
	got := Unmanaged(trusted, []string{
		`c:\users\s\downloads\chromium\chrome.exe`,
		`c:\program files (x86)\microsoft\edge\application\msedge.exe`,
		`c:\program files\google\chrome\application\chrome.exe`,
		`c:\program files evil\chrome.exe`,
	})
	if !reflect.DeepEqual(got, []string{"chrome.exe"}) {
		t.Fatalf("got %v", got)
	}
}
