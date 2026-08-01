package testharness

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// TestINInstructionCosts measures the total T-state cost of the port
// input instructions on a 48K with the counter positioned outside the
// display window (no contention holds). Documented hardware costs:
// IN A,(n) = 11T, IN r,(C) = 12T, OUT (n),A = 11T, OUT (C),r = 12T.
func TestINInstructionCosts(t *testing.T) {
	cases := []struct {
		name string
		code []byte
		bc   uint16
		a    byte
		want uint64
	}{
		{"IN A,($FE) ULA port", []byte{0xDB, 0xFE}, 0, 0x00, 11},
		{"IN A,($FF) unattached", []byte{0xDB, 0xFF}, 0, 0x00, 11},
		{"IN A,(C) port 28FF", []byte{0xED, 0x78}, 0x28FF, 0, 12},
		{"IN A,(C) port 00FE", []byte{0xED, 0x78}, 0x00FE, 0, 12},
		{"IN A,(C) port 40FF", []byte{0xED, 0x78}, 0x40FF, 0, 12},
		{"OUT ($FE),A", []byte{0xD3, 0xFE}, 0, 0x00, 11},
		{"OUT (C),A", []byte{0xED, 0x79}, 0x28FF, 0, 12},
	}
	for _, tc := range cases {
		h, err := New(roms.Model48K)
		if err != nil {
			t.Fatal(err)
		}
		c := h.CPU()
		mem := h.MemoryBus()
		for i, b := range tc.code {
			h.WriteMemory(0x8000+uint16(i), b)
		}
		c.PC = 0x8000
		c.B = byte(tc.bc >> 8)
		c.C = byte(tc.bc)
		c.A = tc.a
		*mem.TStates = 100000 // border: contention holds all zero
		before := *mem.TStates
		c.StepInstruction()
		got := *mem.TStates - before
		if got != tc.want {
			t.Errorf("%s: %d T, want %d", tc.name, got, tc.want)
		} else {
			t.Logf("%s: %d T (ok)", tc.name, got)
		}
	}
}
