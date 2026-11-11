// netschool-helper — talaba kompyuteridagi SYSTEM huquqli xizmat (sinfni bloklash va OS siyosati).
package main

import (
	"fmt"
	"io"
	"os"
	"sort"

	"github.com/humoyun-dev/net-school/native/helper/internal/version"
)

// command — bitta subbuyruq. args subbuyruq nomidan keyingi argumentlar.
type command func(args []string, stdout, stderr io.Writer) int

// commands — subbuyruqlar jadvali. Qolganlari (install, uninstall) keyingi vazifalarda ulanadi. run (xizmat) va
// guard faqat Windows'da ishlaydi (run_windows.go, guard_windows.go), boshqa OS'da xato bilan chiqadi (*_other.go).
var commands = map[string]command{
	"guard":   runGuard,
	"run":     runService,
	"version": runVersion,
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run subbuyruqni tanlaydi va chiqish kodini qaytaradi: 0 — muvaffaqiyat, 2 — noto'g'ri foydalanish.
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printUsage(stderr)
		return 2
	}
	cmd, ok := commands[args[0]]
	if !ok {
		fmt.Fprintf(stderr, "unknown command %q\n", args[0])
		printUsage(stderr)
		return 2
	}
	return cmd(args[1:], stdout, stderr)
}

func printUsage(w io.Writer) {
	names := make([]string, 0, len(commands))
	for name := range commands {
		names = append(names, name)
	}
	sort.Strings(names)
	fmt.Fprint(w, "usage: netschool-helper <command>\ncommands:")
	for _, name := range names {
		fmt.Fprintf(w, " %s", name)
	}
	fmt.Fprintln(w)
}

func runVersion(_ []string, stdout, _ io.Writer) int {
	fmt.Fprintln(stdout, version.Version)
	return 0
}
