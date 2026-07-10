package z80

import "testing"

// Mid-frame NR$07 speed changes. Games on the Next drop to 3.5 MHz just for
// their beeper routines (a timed loop plays 8x too high at 28 MHz) and
// switch back to turbo afterwards — the switches land mid-frame. Two
// invariants make that come out right:
//
//  1. RefTstates advances at the 3.5 MHz reference rate through any pattern
//     of speed changes (segment-by-segment scaling, not raw/currentMult).
//  2. An in-flight ExecuteFrame budget is rescaled at the switch so the
//     frame still spans ~tstatesPerFrame reference T-states (20ms of
//     machine time) — not the turbo-sized raw budget executed at 3.5 MHz,
//     which crammed up to 8 frames of CPU time into one 20ms frame and made
//     the sound play up to 8x too fast.

// TestRefTstatesAcrossSpeedChanges drives the counter through 28 MHz,
// 3.5 MHz and 14 MHz segments and checks the reference clock sums the
// segments at their own multipliers.
func TestRefTstatesAcrossSpeedChanges(t *testing.T) {
	cpu, _ := createTestCPU()
	defer cleanupTestROMs("test_roms_z80")

	cpu.SetSpeedSelect(3) // 28 MHz, x8
	cpu.SetTstates(cpu.Tstates() + 800)
	if got := cpu.RefTstates(); got != 100 {
		t.Fatalf("after 800 raw T at x8: RefTstates = %d, want 100", got)
	}
	cpu.SetSpeedSelect(0) // 3.5 MHz, x1
	cpu.SetTstates(cpu.Tstates() + 100)
	if got := cpu.RefTstates(); got != 200 {
		t.Fatalf("after +100 raw T at x1: RefTstates = %d, want 200", got)
	}
	cpu.SetSpeedSelect(2) // 14 MHz, x4
	cpu.SetTstates(cpu.Tstates() + 400)
	if got := cpu.RefTstates(); got != 300 {
		t.Fatalf("after +400 raw T at x4: RefTstates = %d, want 300", got)
	}
}

// TestMidFrameSlowdownRescalesFrameBudget starts a frame at 28 MHz, drops to
// 3.5 MHz partway through (from inside the instruction stream, as a guest
// NR$07 write would), and checks the frame ends after ~tstatesPerFrame
// REFERENCE T-states — not after the raw turbo budget.
func TestMidFrameSlowdownRescalesFrameBudget(t *testing.T) {
	cpu, mem := createTestCPU()
	defer cleanupTestROMs("test_roms_z80")

	// NOP-fill the top 32K so the CPU just burns 4T instructions.
	for a := 0x8000; a <= 0xFFFF; a++ {
		mem.Write(uint16(a), 0x00)
	}
	cpu.PC = 0x8000
	cpu.IFF1 = false // frame INT stays unaccepted

	const tpf = 1000 // small frame keeps the test fast
	cpu.SetSpeedSelect(3)
	refStart := cpu.RefTstates()
	rawStart := cpu.Tstates()

	switched := false
	var rawAtSwitch, rawLast uint64
	cpu.PreFetchHook = func(pc uint16) {
		rawLast = cpu.Tstates()
		// Halfway through the reference frame (500 ref T = 4000 raw at x8),
		// drop to 3.5 MHz.
		if !switched && cpu.Tstates()-rawStart >= 4000 {
			cpu.SetSpeedSelect(0)
			rawAtSwitch = cpu.Tstates()
			switched = true
		}
	}
	cpu.ExecuteFrame(tpf)

	if !switched {
		t.Fatal("test setup: speed switch never fired")
	}
	// Reference time consumed by the frame must be ~tpf (a few T of
	// rounding at the switch and the final instruction overshoot).
	refSpent := cpu.RefTstates() - refStart
	if refSpent < tpf-8 || refSpent > tpf+8 {
		t.Errorf("frame consumed %d reference T-states, want ~%d", refSpent, tpf)
	}
	// Raw shape: ~4000 raw at x8 (500 ref) + ~500 raw at x1. Without the
	// rescale the frame would run to the full raw budget of 8000 — the
	// 3.5 MHz tail would burn ~4000 raw T-states (4 extra reference frames
	// of CPU time, the "sound effect plays 8x too fast" bug).
	rawTail := rawLast - rawAtSwitch
	if rawTail > tpf {
		t.Errorf("post-switch tail ran %d raw T-states, want ~%d (budget not rescaled?)",
			rawTail, tpf/2)
	}
}
