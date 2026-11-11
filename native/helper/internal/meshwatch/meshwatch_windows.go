//go:build windows

// Package meshwatch MeshAgent xizmatini kuzatadi: u to'xtab qolsa (PoC risk #16: `STOPPED`, chiqish kodi 0,
// sababsiz) qayta ishga tushiradi. Xizmat nomi MeshCentral standarti `Mesh Agent`: infra/meshcentral konfiguratsiyasida
// `agentCustomization.serviceName` berilmagan (webserver.js standart nomni ishlatadi).
package meshwatch

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// ServiceName MeshAgent'ning Windows xizmati nomi.
const ServiceName = "Mesh Agent"

// Interval xizmat (Task 10 orkestri) Check'ni shu oraliqda chaqiradi.
const Interval = 15 * time.Second

// Holatlar (hub.MeshAgent* bilan bir xil).
const (
	StateRunning   = "running"
	StateRestarted = "restarted"
	StateStopped   = "stopped"
)

// Check MeshAgent xizmati holatini qaytaradi; to'xtagan bo'lsa ishga tushiradi va `restarted` qaytaradi. Xizmat
// o'rnatilmagan yoki ishga tushmasa `stopped` va xato.
func Check() (string, error) { return check(ServiceName) }

func check(name string) (string, error) {
	m, err := mgr.Connect()
	if err != nil {
		return StateStopped, fmt.Errorf("SCM'ga ulanilmadi: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return StateStopped, fmt.Errorf("%q xizmati ochilmadi: %w", name, err)
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return StateStopped, fmt.Errorf("%q holati o'qilmadi: %w", name, err)
	}
	switch st.State {
	case svc.Running, svc.StartPending, svc.ContinuePending:
		return StateRunning, nil
	case svc.Stopped:
		if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
			return StateStopped, fmt.Errorf("%q ishga tushmadi: %w", name, err)
		}
		return StateRestarted, nil
	default:
		// StopPending yoki Paused: to'xtash tugagach keyingi Check uni ishga tushiradi.
		return StateStopped, nil
	}
}
