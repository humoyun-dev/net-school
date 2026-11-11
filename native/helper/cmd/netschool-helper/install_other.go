//go:build !windows

package main

import (
	"fmt"
	"io"
)

// runInstall va runUninstall Windows'dan boshqa OS'da faqat argumentlarni tekshiradi.
func runInstall(args []string, _, stderr io.Writer) int {
	if _, err := parseInstallArgs(args); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	fmt.Fprintln(stderr, "install faqat Windows'da ishlaydi")
	return 2
}

func runUninstall(args []string, _, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintln(stderr, "usage: netschool-helper uninstall")
		return 2
	}
	fmt.Fprintln(stderr, "uninstall faqat Windows'da ishlaydi")
	return 2
}

func runHelperKey(args []string, _, stderr io.Writer) int {
	if _, _, err := parseHelperKeyArgs(args); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	fmt.Fprintln(stderr, "helper-key faqat Windows'da ishlaydi")
	return 2
}

func runSetHub(args []string, _, stderr io.Writer) int {
	if _, err := parseSetHubArgs(args); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	fmt.Fprintln(stderr, "set-hub faqat Windows'da ishlaydi")
	return 2
}
