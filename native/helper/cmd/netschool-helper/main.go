// netschool-helper — talaba kompyuteridagi SYSTEM huquqli xizmat (sinfni bloklash va OS siyosati).
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"

	"github.com/humoyun-dev/net-school/native/helper/internal/version"
)

// command — bitta subbuyruq. args subbuyruq nomidan keyingi argumentlar.
type command func(args []string, stdout, stderr io.Writer) int

// commands — subbuyruqlar jadvali. run (xizmat), guard, install va uninstall faqat Windows'da ishlaydi
// (*_windows.go), boshqa OS'da xato bilan chiqadi (*_other.go).
var commands = map[string]command{
	"guard":     runGuard,
	"install":   runInstall,
	"run":       runService,
	"uninstall": runUninstall,
	"version":   runVersion,
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

const installUsage = "usage: netschool-helper install --companion-dir <yoyilgan paket katalogi>"

// parseInstallArgs `install --companion-dir <dir>` argumentlari.
func parseInstallArgs(args []string) (string, error) {
	if len(args) != 2 || args[0] != "--companion-dir" || args[1] == "" {
		return "", errors.New(installUsage)
	}
	return args[1], nil
}
