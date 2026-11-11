//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"

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

// runHelperKey `helper-key --token <t> [--rotate]`: enroll (elevated) claim'dan oldin chaqiradi. stdout'ga faqat
// JSON {helperPublicKey, helperProof}; token chiqarilmaydi.
func runHelperKey(args []string, stdout, stderr io.Writer) int {
	token, rotate, err := parseHelperKeyArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return install.ExitUsage
	}
	if !install.IsElevated() {
		fmt.Fprintln(stderr, "helper-key administrator sifatida ishga tushirilishi kerak")
		return install.ExitNotAdmin
	}
	res, err := install.HelperKey(token, rotate)
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

// runSetHub `set-hub --origin <url> --device-id <id> [--ca-file <path>]`: enroll claim'dan keyin chaqiradi.
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
	if err := install.SetHub(a.origin, a.deviceID, a.caFile); err != nil {
		fmt.Fprintf(stderr, "set-hub: %v\n", err)
		return install.ExitFailed
	}
	fmt.Fprintln(stdout, "helper hub konfiguratsiyasi yozildi")
	return install.ExitOK
}
