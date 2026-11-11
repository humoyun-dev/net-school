//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"

	"github.com/humoyun-dev/net-school/native/helper/internal/guard"
)

// runGuard o'quvchi sessiyasidagi SYSTEM guard jarayoni: xizmat uni StartAsSystemInSession bilan ishga tushiradi.
// Argument qabul qilmaydi.
func runGuard(args []string, _, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintln(stderr, "usage: netschool-helper guard")
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := guard.Main(ctx); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(stderr, "guard: %v\n", err)
		return 1
	}
	return 0
}
