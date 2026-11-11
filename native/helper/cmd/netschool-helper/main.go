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

// commands — subbuyruqlar jadvali. run (xizmat), guard, install, uninstall, helper-key va set-hub faqat Windows'da ishlaydi
// (*_windows.go), boshqa OS'da xato bilan chiqadi (*_other.go).
var commands = map[string]command{
	"guard":      runGuard,
	"helper-key": runHelperKey,
	"install":    runInstall,
	"run":        runService,
	"set-hub":    runSetHub,
	"uninstall":  runUninstall,
	"version":    runVersion,
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

// flagValues `--nom qiymat` juftlarini o'qiydi: faqat allowed nomlar, har biri bir marta, qiymat bo'sh emas.
// boolFlags qiymatsiz bayroqlar.
func flagValues(args []string, allowed []string, boolFlags []string) (map[string]string, error) {
	out := map[string]string{}
	isAllowed := func(list []string, name string) bool {
		for _, a := range list {
			if a == name {
				return true
			}
		}
		return false
	}
	for i := 0; i < len(args); i++ {
		name := args[i]
		if _, dup := out[name]; dup {
			return nil, fmt.Errorf("%s ikki marta berilgan", name)
		}
		switch {
		case isAllowed(boolFlags, name):
			out[name] = "true"
		case isAllowed(allowed, name):
			if i+1 >= len(args) || args[i+1] == "" {
				return nil, fmt.Errorf("%s qiymatsiz", name)
			}
			out[name] = args[i+1]
			i++
		default:
			return nil, fmt.Errorf("noma'lum argument %q", name)
		}
	}
	return out, nil
}

const helperKeyUsage = "usage: netschool-helper helper-key --token <enrollment token> [--rotate]"

// parseHelperKeyArgs `helper-key --token <t> [--rotate]`.
func parseHelperKeyArgs(args []string) (token string, rotate bool, err error) {
	v, err := flagValues(args, []string{"--token"}, []string{"--rotate"})
	if err != nil || v["--token"] == "" {
		return "", false, errors.New(helperKeyUsage)
	}
	return v["--token"], v["--rotate"] == "true", nil
}

const setHubUsage = "usage: netschool-helper set-hub --origin <https://hub> --device-id <uuid> [--ca-file <pem>]"

type setHubArgs struct{ origin, deviceID, caFile string }

// parseSetHubArgs `set-hub --origin <url> --device-id <id> [--ca-file <path>]`.
func parseSetHubArgs(args []string) (setHubArgs, error) {
	v, err := flagValues(args, []string{"--origin", "--device-id", "--ca-file"}, nil)
	if err != nil || v["--origin"] == "" || v["--device-id"] == "" {
		return setHubArgs{}, errors.New(setHubUsage)
	}
	return setHubArgs{origin: v["--origin"], deviceID: v["--device-id"], caFile: v["--ca-file"]}, nil
}
