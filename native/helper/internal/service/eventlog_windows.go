//go:build windows

package service

import (
	"fmt"

	"golang.org/x/sys/windows/svc/eventlog"
)

// EventSource Windows Event Log manbasi (Application jurnali). Uni `install` (Task 11) ro'yxatdan o'tkazadi; o'tmagan
// bo'lsa ham Windows yozuvni qabul qiladi (xabar matni "tavsif topilmadi" izohi bilan ko'rinadi).
const EventSource = "NetSchoolHelper"

// eventID helper yozuvlarining hammasi bitta ID bilan: matnning o'zi sababni aytadi.
const eventID = 1

// eventLogger Logger'ni Event Log'ga yozadi. Manba ochilmasa yozuvlar tashlab yuboriladi (xizmat jurnalsiz ham
// ishlashi kerak).
type eventLogger struct{ l *eventlog.Log }

func openEventLogger() *eventLogger {
	l, err := eventlog.Open(EventSource)
	if err != nil {
		return &eventLogger{}
	}
	return &eventLogger{l: l}
}

// Warn xato va tiklanish yozuvlari (Logger porti).
func (e *eventLogger) Warn(format string, args ...any) {
	if e.l != nil {
		_ = e.l.Warning(eventID, fmt.Sprintf(format, args...))
	}
}

func (e *eventLogger) Info(format string, args ...any) {
	if e.l != nil {
		_ = e.l.Info(eventID, fmt.Sprintf(format, args...))
	}
}

func (e *eventLogger) Close() {
	if e.l != nil {
		_ = e.l.Close()
	}
}
