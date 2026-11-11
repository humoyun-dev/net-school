//go:build windows

package main

import (
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
	if err := install.Uninstall(stdout); err != nil {
		fmt.Fprintf(stderr, "uninstall: %v\n", err)
		return install.ExitFailed
	}
	return install.ExitOK
}
