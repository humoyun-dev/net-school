//go:build windows

package browser

import (
	"bytes"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"

	"github.com/humoyun-dev/net-school/native/helper/internal/fsacl"
	"github.com/humoyun-dev/net-school/native/helper/internal/procguard"
)

// WriteHostManifest manifest'ni `dir`ga yozadi: katalog SYSTEM/Administrators yozadigan, Users o'qiydigan qilib
// himoyalanadi (o'quvchi host yo'lini almashtira olmasin); mazmun o'zgarmasa yozilmaydi.
func WriteHostManifest(dir string, data []byte) (string, error) {
	if _, err := fsacl.Harden(dir, fsacl.Readable); err != nil {
		return "", err
	}
	path := filepath.Join(dir, HostName+".json")
	if cur, err := os.ReadFile(path); err == nil && bytes.Equal(cur, data) {
		return path, nil
	}
	tmp := path + ".new"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	_, err := fsacl.Harden(dir, fsacl.Readable)
	return path, err
}

// UnmanagedRunning sessiyadagi boshqarilmaydigan brauzerlar (Program Files'dan tashqaridagi chrome/msedge ham).
func UnmanagedRunning(session uint32) ([]string, error) {
	var trusted []string
	for _, id := range []*windows.KNOWNFOLDERID{windows.FOLDERID_ProgramFiles, windows.FOLDERID_ProgramFilesX86} {
		if dir, err := windows.KnownFolderPath(id, 0); err == nil {
			trusted = append(trusted, dir)
		}
	}
	procs, err := procguard.Snapshot()
	if err != nil {
		return nil, err
	}
	var images []string
	for _, p := range procs {
		if p.Session == session {
			images = append(images, p.Image)
		}
	}
	return Unmanaged(trusted, images), nil
}
