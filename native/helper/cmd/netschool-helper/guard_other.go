//go:build !windows

package main

import (
	"fmt"
	"io"
)

// runGuard Windows'dan boshqa OS'da ishlamaydi: subbuyruq jadvali har OS'da yig'ilishi uchun.
func runGuard(_ []string, _, stderr io.Writer) int {
	fmt.Fprintln(stderr, "guard faqat Windows'da ishlaydi")
	return 2
}
