package ula

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/memory"
)

// TestActiveVideoLine verifies the live raster-line counter exposed via
// NextReg $1E/$1F. Two properties matter:
//
//  1. It advances as the CPU's T-state counter advances within the frame —
//     NextZXOS dot commands (e.g. NextGuide) DISABLE interrupts and poll
//     it, so a frozen value hangs the wait loop (the "frozen Guide" bug).
//  2. It counts in the FPGA cvc convention (zxnext.vhd:5982-5986): 0 is
//     the TOP PAPER line, which starts 64 raw lines after the frame INT
//     (the same origin the NR$22/$23 line interrupt uses — see
//     WireLineInterrupt). The MrKWatkins suite's WaitForScanline loops
//     place raster-timed NR$15/border phases by these values; the raw
//     from-INT convention put every phase 64 lines off.
func TestActiveVideoLine(t *testing.T) {
	var ts uint64
	mem := &memory.Memory{}
	mem.TStates = &ts
	u := &ULA{mem: mem, frameStartTstate: 100}

	// The frame INT fires 64 lines before the paper: cvc = 311-64 = 247.
	ts = 100
	if got := u.ActiveVideoLine(); got != 247 {
		t.Errorf("ActiveVideoLine at INT = %d, want 247", got)
	}
	// Raw line 64 = top paper line = cvc 0.
	ts = 100 + uint64(TStatesPerLine*64)
	if got := u.ActiveVideoLine(); got != 0 {
		t.Errorf("ActiveVideoLine at paper top = %d, want 0", got)
	}
	// Part-way through paper line 5.
	ts = 100 + uint64(TStatesPerLine*(64+5)+50)
	if got := u.ActiveVideoLine(); got != 5 {
		t.Errorf("ActiveVideoLine = %d, want 5", got)
	}
	// Advances with T-states — the property the DI'd raster-wait needs.
	ts = 100 + uint64(TStatesPerLine*(64+7))
	if got := u.ActiveVideoLine(); got != 7 {
		t.Errorf("ActiveVideoLine = %d, want 7 (must advance)", got)
	}
	// Last paper line then the bottom border: cvc 191, 192.
	ts = 100 + uint64(TStatesPerLine*(64+191))
	if got := u.ActiveVideoLine(); got != 191 {
		t.Errorf("ActiveVideoLine = %d, want 191", got)
	}
	ts = 100 + uint64(TStatesPerLine*(64+192))
	if got := u.ActiveVideoLine(); got != 192 {
		t.Errorf("ActiveVideoLine = %d, want 192 (bottom border)", got)
	}
	// No T-state source → the INT-time value, not a panic.
	if got := (&ULA{}).ActiveVideoLine(); got != 247 {
		t.Errorf("ActiveVideoLine with nil mem = %d, want 247", got)
	}
}

// TestBeamPosition verifies the per-T-state beam-position model: scanline
// and 8-pixel hpos derived from the T-state counter (the foundation for
// per-T-state Copper / contention / ULA-per-scanline).
func TestBeamPosition(t *testing.T) {
	var ts uint64
	mem := &memory.Memory{}
	mem.TStates = &ts
	u := &ULA{mem: mem, frameStartTstate: 100}

	// Part-way through line 5: T-state offset 40 → hpos 40/4 = 10.
	ts = 100 + uint64(TStatesPerLine*5+40)
	if line, hpos := u.BeamPosition(); line != 5 || hpos != 10 {
		t.Errorf("mid line 5: got line=%d hpos=%d, want 5,10", line, hpos)
	}
	// Top-left of the frame.
	ts = 100
	if line, hpos := u.BeamPosition(); line != 0 || hpos != 0 {
		t.Errorf("frame start: got line=%d hpos=%d, want 0,0", line, hpos)
	}
	// ActiveVideoLine stays consistent with BeamPosition's line (raw line
	// 64+7 = paper line 7 in the cvc convention).
	ts = 100 + uint64(TStatesPerLine*(64+7)+200)
	if u.ActiveVideoLine() != 7 {
		t.Errorf("ActiveVideoLine = %d, want 7", u.ActiveVideoLine())
	}
	// No T-state source → (0,0), not a panic.
	if line, hpos := (&ULA{}).BeamPosition(); line != 0 || hpos != 0 {
		t.Errorf("nil mem: got line=%d hpos=%d, want 0,0", line, hpos)
	}
}
