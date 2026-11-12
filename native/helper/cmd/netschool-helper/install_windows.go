//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/humoyun-dev/net-school/native/helper/internal/fsacl"
	"github.com/humoyun-dev/net-school/native/helper/internal/install"
)

// runInstall `netschool-helper install --companion-dir <dir>`: administrator (elevated) talab qiladi.
func runInstall(args []string, stdout, stderr io.Writer) int {
	dir, err := parseInstallArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return install.ExitUsage
	}
	if !install.IsElevated() {
		fmt.Fprintln(stderr, "install administrator sifatida ishga tushirilishi kerak")
		return install.ExitNotAdmin
	}
	if err := install.Install(dir, stdout); err != nil {
		fmt.Fprintf(stderr, "install: %v\n", err)
		return install.ExitFailed
	}
	return install.ExitOK
}

// runUninstall `netschool-helper uninstall`: administrator talab qiladi.
func runUninstall(args []string, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintln(stderr, "usage: netschool-helper uninstall")
		return install.ExitUsage
	}
	if !install.IsElevated() {
		fmt.Fprintln(stderr, "uninstall administrator sifatida ishga tushirilishi kerak")
		return install.ExitNotAdmin
	}
	if err := install.Uninstall(stdout); errors.Is(err, install.ErrRunFromInstallDir) {
		fmt.Fprintln(stderr, err)
		return install.ExitUsage
	} else if err != nil {
		fmt.Fprintf(stderr, "uninstall: %v\n", err)
		return install.ExitFailed
	}
	return install.ExitOK
}

// runHelperKey `helper-key --token-stdin [--rotate]`: enroll (elevated) claim'dan oldin chaqiradi va tokenni
// stdin'ga yozadi. stdout'ga faqat JSON {helperPublicKey, helperProof}; token chiqarilmaydi.
func runHelperKey(args []string, stdout, stderr io.Writer) int {
	rotate, err := parseHelperKeyArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return install.ExitUsage
	}
	if !install.IsElevated() {
		fmt.Fprintln(stderr, "helper-key administrator sifatida ishga tushirilishi kerak")
		return install.ExitNotAdmin
	}
	token, err := readTokenLine(os.Stdin)
	if err != nil {
		fmt.Fprintf(stderr, "helper-key: stdin'dagi token yaroqsiz: %v\n", err)
		return install.ExitUsage
	}
	res, err := install.HelperKey(token, rotate)
	if res.DataRootReplaced {
		// stdout faqat JSON: ogohlantirish stderr'ga (enroll uni JSON'dagi dataRootReplaced bo'yicha o'zi ham chiqaradi).
		fmt.Fprintln(stderr, fsacl.RootReplacedWarning)
	}
	if err != nil {
		fmt.Fprintf(stderr, "helper-key: %v\n", err)
		return install.ExitFailed
	}
	if err := json.NewEncoder(stdout).Encode(res); err != nil {
		fmt.Fprintf(stderr, "helper-key: %v\n", err)
		return install.ExitFailed
	}
	return install.ExitOK
}

// runSetHub `set-hub --origin <url> --device-id <id> [--ca-stdin]`: enroll claim'dan keyin chaqiradi. CA PEM
// baytlari (enroll claim'dan oldin tekshirgan aynan o'sha baytlar) stdin'dan o'qiladi va qayta tekshiriladi.
func runSetHub(args []string, stdout, stderr io.Writer) int {
	a, err := parseSetHubArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return install.ExitUsage
	}
	if !install.IsElevated() {
		fmt.Fprintln(stderr, "set-hub administrator sifatida ishga tushirilishi kerak")
		return install.ExitNotAdmin
	}
	var ca []byte
	if a.caStdin {
		ca, err = io.ReadAll(io.LimitReader(os.Stdin, install.MaxCABytes+1))
		if err != nil {
			fmt.Fprintf(stderr, "set-hub: CA o'qilmadi: %v\n", err)
			return install.ExitFailed
		}
	}
	if err := install.SetHub(a.origin, a.deviceID, ca); err != nil {
		fmt.Fprintf(stderr, "set-hub: %v\n", err)
		return install.ExitFailed
	}
	fmt.Fprintln(stdout, "helper hub konfiguratsiyasi yozildi")
	return install.ExitOK
}
