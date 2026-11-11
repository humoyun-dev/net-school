//go:build windows

package main

import (
	"fmt"
	"io"

	"golang.org/x/sys/windows/svc"

	"github.com/humoyun-dev/net-school/native/helper/internal/service"
)

// runService xizmat kirish nuqtasi: SCM `netschool-helper.exe run` ni ishga tushiradi. Konsoldan ishga tushirilsa
// rad etadi (xizmat SYSTEM huquqi va SCM boshqaruvini talab qiladi).
func runService(args []string, _, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintln(stderr, "usage: netschool-helper run")
		return 2
	}
	isService, err := svc.IsWindowsService()
	if err != nil {
		fmt.Fprintf(stderr, "run: %v\n", err)
		return 1
	}
	if !isService {
		fmt.Fprintf(stderr, "run faqat Windows xizmati sifatida (%s) ishga tushadi\n", service.Name)
		return 2
	}
	if err := service.Run(); err != nil {
		fmt.Fprintf(stderr, "run: %v\n", err)
		return 1
	}
	return 0
}
