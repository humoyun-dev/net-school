// netschool-helper — talaba kompyuteridagi SYSTEM huquqli xizmat (sinfni bloklash va OS siyosati).
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/humoyun-dev/net-school/native/helper/internal/install"
	"github.com/humoyun-dev/net-school/native/helper/internal/nativehost"
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
	// Chrome/Edge native messaging: brauzer host'ni `chrome-extension://<id>/` argumenti bilan ishga tushiradi.
	if nativehost.IsHostInvocation(os.Args[1:]) {
		if err := nativehost.Run(context.Background(), os.Stdin, os.Stdout, nativehost.Dial, nativehost.RetryInterval); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
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

const helperKeyUsage = "usage: netschool-helper helper-key --token-stdin [--rotate]  (token stdin'dan, bitta qator)"

// parseHelperKeyArgs `helper-key --token-stdin [--rotate]`. Token argv'da emas (jarayonlar ro'yxatida ko'rinmasin):
// faqat stdin'dan.
func parseHelperKeyArgs(args []string) (rotate bool, err error) {
	v, err := flagValues(args, nil, []string{"--token-stdin", "--rotate"})
	if err != nil || v["--token-stdin"] != "true" {
		return false, errors.New(helperKeyUsage)
	}
	return v["--rotate"] == "true", nil
}

// maxTokenLine stdin'dagi token qatorining eng katta hajmi (install.ValidateToken 512 belgigacha qabul qiladi).
const maxTokenLine = 1024

// readTokenLine stdin'dan bitta qatorni o'qiydi (oxiridagi \r\n yoki \n olib tashlanadi), undan keyin hech narsa
// bo'lmasligi kerak. Qiymat install.ValidateToken bilan tekshiriladi.
func readTokenLine(r io.Reader) (string, error) {
	raw, err := io.ReadAll(io.LimitReader(r, maxTokenLine+1))
	if err != nil {
		return "", err
	}
	if len(raw) > maxTokenLine {
		return "", errors.New("token qatori juda uzun")
	}
	line := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
	if err := install.ValidateToken(line); err != nil {
		return "", err
	}
	return line, nil
}

const setHubUsage = "usage: netschool-helper set-hub --origin <https://hub> --device-id <uuid> [--ca-stdin]  (CA PEM stdin'dan)"

type setHubArgs struct {
	origin, deviceID string
	caStdin          bool
}

// parseSetHubArgs `set-hub --origin <url> --device-id <id> [--ca-stdin]`.
func parseSetHubArgs(args []string) (setHubArgs, error) {
	v, err := flagValues(args, []string{"--origin", "--device-id"}, []string{"--ca-stdin"})
	if err != nil || v["--origin"] == "" || v["--device-id"] == "" {
		return setHubArgs{}, errors.New(setHubUsage)
	}
	return setHubArgs{origin: v["--origin"], deviceID: v["--device-id"], caStdin: v["--ca-stdin"] == "true"}, nil
}
