//go:build windows

package service

import (
	"strconv"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// bootIDKey Windows har boot'da oshiradigan hisoblagich (REG_DWORD `BootId`). U devor soatidan olinmaydi, shuning
// uchun soat o'zgartirilganda boot identifikatori o'zgarmaydi.
const bootIDKey = `SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`

// systemClock lock.Clock'ning Windows realizatsiyasi.
//
//   - Uptime: GetTickCount64 (monoton, uyqu/gibernatsiya vaqtini ham o'z ichiga oladi): lease devor soatini
//     o'zgartirib cho'zilmaydi va kompyuter uxlab qolsa ham tugaydi.
//   - BootID: `bootIDKey\BootId` hisoblagichi (`reg:<n>`). U o'qilmasa zaxira — boot paytining devor soati
//     (Now − Uptime) bir daqiqaga yaxlitlangan (`t:<unix>`): xizmat bir boot ichida qayta ishga tushganda soat bir
//     daqiqadan kam o'zgargan bo'lsa (odatda NTP tuzatishi soniyalar) qiymat bir xil. Chegaradan o'tib qolsa
//     natija xavfsiz tomonda: saqlangan lock tiklanmaydi. Qiymat jarayon boshida bir marta hisoblanadi va
//     o'zgarmaydi.
type systemClock struct{ bootID string }

func newSystemClock() *systemClock {
	return &systemClock{bootID: readBootID()}
}

func readBootID() string {
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, bootIDKey, registry.QUERY_VALUE); err == nil {
		defer k.Close()
		if v, _, err := k.GetIntegerValue("BootId"); err == nil {
			return "reg:" + strconv.FormatUint(v, 10)
		}
	}
	boot := time.Now().Add(-windows.DurationSinceBoot()).Round(time.Minute)
	return "t:" + strconv.FormatInt(boot.Unix(), 10)
}

func (*systemClock) Now() time.Time        { return time.Now() }
func (*systemClock) Uptime() time.Duration { return windows.DurationSinceBoot() }
func (c *systemClock) BootID() string      { return c.bootID }
