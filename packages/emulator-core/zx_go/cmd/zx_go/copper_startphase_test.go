package main

import "testing"

// TestCopperStartPhaseRebasesToPaperTop pins the #197 fix: the copper's
// start debt is measured from the COPPER's frame origin (paper top), not
// the CPU's (the frame INT).
//
// The render walk drives copper vcount in paper rows, so a stopped→running
// NR$62 write inside the top border — where a guest ISR naturally re-arms
// its list — must leave the copper with NO debt. Charging it the CPU-origin
// offset starved the first paper lines, blew past the list's first
// strict-equality WAIT, and parked the copper for the whole frame; Quantum
// Storm lost its per-band tilemap scroll on alternate frames as a result.
func TestCopperStartPhaseRebasesToPaperTop(t *testing.T) {
	// Boot geometry: 228 T/line, paper top at line 64.
	const tPerLine, minVActive = 228, 64
	line := tPerLine * 8 // one line in 28 MHz copper cycles
	paperTop := minVActive * line

	tests := []struct {
		name     string
		cpuPhase int
		want     int
	}{
		{"frame INT itself", 0, 0},
		{"early top border", 2 * line, 0},
		{"Quantum Storm's ISR restart (~9.65 lines in)", 17604, 0},
		{"last line before paper", paperTop - 1, 0},
		{"exactly paper top", paperTop, 0},
		{"one line into paper", paperTop + line, line},
		{"ten lines into paper", paperTop + 10*line, 10 * line},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := copperStartPhase(tc.cpuPhase, minVActive, tPerLine); got != tc.want {
				t.Errorf("copperStartPhase(%d) = %d, want %d", tc.cpuPhase, got, tc.want)
			}
		})
	}
}

// TestCopperStartPhaseHonoursGeometry checks the rebase follows the live
// NR$03/NR$05 geometry rather than a hardcoded 64-line border: 60 Hz
// timing puts paper top at line 40, Pentagon at 80.
func TestCopperStartPhaseHonoursGeometry(t *testing.T) {
	const tPerLine = 228
	line := tPerLine * 8
	// 45 lines in: past paper top under 60 Hz (40), still in the border
	// under the 50 Hz (64) and Pentagon (80) geometries.
	phase := 45 * line
	if got := copperStartPhase(phase, 40, tPerLine); got != 5*line {
		t.Errorf("60 Hz geometry: got %d, want %d", got, 5*line)
	}
	if got := copperStartPhase(phase, 64, tPerLine); got != 0 {
		t.Errorf("50 Hz geometry: got %d, want 0", got)
	}
	if got := copperStartPhase(phase, 80, tPerLine); got != 0 {
		t.Errorf("Pentagon geometry: got %d, want 0", got)
	}
}
