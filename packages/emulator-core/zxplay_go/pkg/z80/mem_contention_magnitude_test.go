package z80

import "testing"

// Contention MAGNITUDE, not just presence (#189). Direction-only tests
// pass just as well when the model charges 1 T as when it charges 100,
// so the delivered slowdown is pinned here against a first-principles
// figure.
//
// Reference arithmetic for a 48K frame of NOPs executing entirely from
// contended RAM. The naive figure — mean hold (6+5+4+3+2+1+0+0)/8 =
// 2.625 T, so a 4 T NOP costs 6.625 T — is WRONG, because a repeating
// access does not sample the pattern evenly: it LOCKS to one slot.
//
//	NOP fetch at pattern slot 0 -> hold 6 -> costs 10 T
//	10 mod 8 = 2, so the next fetch lands at slot 2 -> hold 4 -> 8 T
//	8 mod 8 = 0, so every later fetch stays at slot 2 -> 8 T forever
//
// The loop settles at a fixed 8 T per NOP inside the window:
//
//	frame              = 69888 T (312 lines x 224 T)
//	contended window   = 192 display lines x 128 T pixel fetch = 24576 T
//	in-window          = 24576 / 8 = 3072 instructions
//	out-of-window      = (69888 - 24576) / 4 = 11328 instructions
//	contended total    = 14400
//	uncontended total  = 69888 / 4 = 17472
//	ratio              = 0.824
//
// Pinned exactly: the numbers follow from the canonical {6,5,4,3,2,1,
// 0,0} pattern and the 48K frame geometry, so a drift here means the
// hold is charged at the wrong scale or the wrong instant — the failure
// mode that matters, since too little contention leaves #189's games
// fast and too much makes them sluggish.
func TestMemContention_FrameThroughputMagnitude(t *testing.T) {
	run := func(contend bool, org uint16) int {
		cpu, mem := createTestCPU()
		defer cleanupTestROMs("test_roms_z80")
		cpu.MemContend = contend
		// A frame's worth of NOPs, wrapping via a JR back to the top
		// would itself contend unevenly — instead fill a page and let
		// the PC run straight through it.
		for i := 0; i < 0x1000; i++ {
			mem.Write(org+uint16(i), 0x00)
		}
		cpu.PC = org
		cpu.SP = 0xFFF0
		cpu.tstates = 0
		count := 0
		for cpu.tstates < 69888 {
			cpu.StepInstruction()
			count++
			// Wrap back to the page top before running off the end.
			if cpu.PC >= org+0x0F00 {
				cpu.PC = org
			}
		}
		return count
	}

	contended := run(true, 0x4000)
	uncontended := run(false, 0x4000)
	ratio := float64(contended) / float64(uncontended)
	t.Logf("contended %d instr/frame, uncontended %d, ratio %.3f", contended, uncontended, ratio)
	if uncontended != 17472 {
		t.Errorf("uncontended baseline %d instr/frame, want 69888/4 = 17472", uncontended)
	}
	if contended != 14400 {
		t.Errorf("contended %d instr/frame, want 14400 (24576/8 in-window + 45312/4 out) — "+
			"contention magnitude or instant is wrong", contended)
	}

	// Code in UNCONTENDED RAM must keep full throughput: the ULA holds
	// nothing there, so the ratio is 1.
	upperContended := run(true, 0x8000)
	upperBaseline := run(false, 0x8000)
	if upperContended != upperBaseline {
		t.Errorf("uncontended RAM: %d instr/frame with contention vs %d without — should be identical",
			upperContended, upperBaseline)
	}
}
