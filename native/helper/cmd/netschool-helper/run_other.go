//go:build !windows

package main

import (
	"fmt"
	"io"
)

// runService Windows'dan boshqa OS'da ishlamaydi: subbuyruq jadvali har OS'da yig'ilishi uchun.
func runService(_ []string, _, stderr io.Writer) int {
	fmt.Fprintln(stderr, "run faqat Windows'da ishlaydi")
	return 2
}
