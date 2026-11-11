package keys

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Fixture TS tomoni (apps/companion/test/key-policy.test.ts) bilan umumiy: ikkala til bir xil ketma-ketlikda bir xil block[] berishi shart.
const fixturePath = "../../../../packages/contracts/fixtures/key-policy.json"

type fixtureEvent struct {
	Kind  string `json:"kind"`
	VK    uint32 `json:"vk"`
	Flags uint32 `json:"flags"`
}

type fixtureSequence struct {
	Name   string         `json:"name"`
	Events []fixtureEvent `json:"events"`
	// Block: har hodisaga bitta qiymat; "reset" hodisasi uchun null.
	Block []*bool `json:"block"`
}

func loadSequences(t *testing.T) []fixtureSequence {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(fixturePath))
	if err != nil {
		t.Fatalf("fixture o'qilmadi: %v", err)
	}
	var fixture struct {
		Comment   string            `json:"_comment"`
		Sequences []fixtureSequence `json:"sequences"`
	}
	// Noma'lum maydon (masalan "vk" o'rniga "vkCode") jim e'tiborsiz qolmasin.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&fixture); err != nil {
		t.Fatalf("fixture JSON noto'g'ri: %v", err)
	}
	return fixture.Sequences
}

func TestFixtureHasEnoughSequences(t *testing.T) {
	sequences := loadSequences(t)
	if len(sequences) < 40 {
		t.Fatalf("fixture'da kamida 40 ketma-ketlik bo'lishi kerak, bor: %d", len(sequences))
	}
	names := map[string]bool{}
	var blocked, passed, reset, lowerILBlocked, injectedPassed bool
	for _, s := range sequences {
		if names[s.Name] {
			t.Errorf("ketma-ketlik nomi takrorlangan: %q", s.Name)
		}
		names[s.Name] = true
		if len(s.Block) != len(s.Events) {
			t.Errorf("%q: block[] uzunligi %d, hodisalar %d", s.Name, len(s.Block), len(s.Events))
			continue
		}
		for i, e := range s.Events {
			if e.Kind == "reset" {
				reset = true
			}
			if s.Block[i] != nil {
				blocked = blocked || *s.Block[i]
				passed = passed || !*s.Block[i]
				// Pastroq darajadagi injected hodisa to'siladi, oddiy injected esa o'tadi: ikkalasi ham fixture'da bo'lishi shart.
				if e.Kind == "down" && e.Flags&0x12 == 0x12 && *s.Block[i] {
					lowerILBlocked = true
				}
				if e.Kind == "down" && e.Flags&0x12 == 0x10 && !*s.Block[i] {
					injectedPassed = true
				}
			}
		}
	}
	if !blocked || !passed || !reset || !lowerILBlocked || !injectedPassed {
		t.Fatalf("fixture to'siladigan (%v), o'tadigan (%v), reset (%v), to'siladigan pastroq-daraja injected (%v) va o'tadigan injected (%v) holatlarini qamrashi kerak",
			blocked, passed, reset, lowerILBlocked, injectedPassed)
	}
}

func TestFixtureSequences(t *testing.T) {
	for _, seq := range loadSequences(t) {
		t.Run(seq.Name, func(t *testing.T) {
			if len(seq.Block) != len(seq.Events) {
				t.Fatalf("block[] uzunligi %d, hodisalar %d", len(seq.Block), len(seq.Events))
			}
			var p Policy
			for i, e := range seq.Events {
				want := seq.Block[i]
				switch e.Kind {
				case "reset":
					if want != nil {
						t.Fatalf("hodisa %d: reset uchun block null bo'lishi kerak", i)
					}
					p.Reset()
				case "down", "up":
					if want == nil {
						t.Fatalf("hodisa %d: %s uchun block true/false bo'lishi kerak", i, e.Kind)
					}
					got := p.Handle(Event{VK: e.VK, Flags: e.Flags, Down: e.Kind == "down"})
					if got != *want {
						t.Fatalf("hodisa %d (%s vk=%d flags=%d): block=%v, kutilgan %v", i, e.Kind, e.VK, e.Flags, got, *want)
					}
				default:
					t.Fatalf("hodisa %d: noma'lum kind %q", i, e.Kind)
				}
			}
		})
	}
}

// Policy'ning nol qiymati ishlaydi: konstruktor kerak emas.
func TestZeroValuePolicyIsReady(t *testing.T) {
	var p Policy
	if !p.Handle(Event{VK: 0x5b, Down: true}) {
		t.Fatal("nol qiymatli Policy Win'ni to'sishi kerak")
	}
}

// Hook callback'i Windows'ning vaqt chegarasida ishlaydi: Handle xotira ajratmasligi kerak.
func TestHandleDoesNotAllocate(t *testing.T) {
	var p Policy
	events := []Event{
		{VK: 0xa4, Down: true},
		{VK: 0x09, Down: true},
		{VK: 0x09, Down: false},
		{VK: 0xa4, Down: false},
		{VK: 0x5b, Down: true},
		{VK: 0x5b, Down: false},
		{VK: 0x41, Flags: 0x10, Down: true},
		{VK: 0x5b, Flags: 0x12, Down: true},
	}
	allocs := testing.AllocsPerRun(100, func() {
		for _, e := range events {
			p.Handle(e)
		}
		p.Reset()
	})
	if allocs != 0 {
		t.Fatalf("Handle/Reset %v marta xotira ajratdi, 0 bo'lishi kerak", allocs)
	}
}
