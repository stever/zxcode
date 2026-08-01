package copper

import "testing"

// loadWords writes a program into the copper list from index 0.
func loadWords(c *Copper, words []uint16) {
	c.SetWritePtrLow(0)
	for _, w := range words {
		c.WriteData(byte(w >> 8))
		c.WriteData(byte(w))
	}
}

func waitWord(x byte, y uint16) uint16 { return 0x8000 | uint16(x&0x3F)<<9 | y&0x1FF }
func moveWord(reg, val byte) uint16    { return uint16(reg&0x7F)<<8 | uint16(val) }

// Re-writing NR$62 with the SAME mode bits must not restart the running
// list — the FPGA resets the address only on a mode TRANSITION into 01/11
// (copper.vhd:70-79). The upstream base/Copper test patches its list's WAIT
// bytes every frame via NR$61/$62 writes carrying mode %11 and relies on
// the run not being disturbed.
func TestSameModeRewriteDoesNotRestartList(t *testing.T) {
	c := New()
	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	loadWords(c, []uint16{
		moveWord(0x41, 0x11),
		waitWord(0, 100), // parks here
		moveWord(0x41, 0x22),
		0xFFFF, // HALT
	})
	c.SetWritePtrHighAndMode(byte(StartOnVBL) << 6)
	c.RunToCycle(0, 100) // executes the first MOVE, parks on WAIT y=100
	if len(rw.writes) != 1 {
		t.Fatalf("setup: %d writes, want 1", len(rw.writes))
	}
	// Re-select a write address with the same mode bits (the Z80 patcher
	// pattern): list must stay parked at the WAIT, not restart.
	c.SetWritePtrHighAndMode(byte(StartOnVBL)<<6 | 0x02)
	c.RunToCycle(50, 1791)
	if len(rw.writes) != 1 {
		t.Fatalf("same-mode rewrite restarted the list: %d writes, want 1", len(rw.writes))
	}
	// The parked WAIT still releases on its line.
	c.RunToCycle(100, 1791)
	if len(rw.writes) != 2 || rw.writes[1].val != 0x22 {
		t.Fatalf("parked WAIT did not release: %v", rw.writes)
	}
}

// A WAIT releases only when vcount EQUALS its target line and hcount has
// reached (X<<3)+12 (copper.vhd:94) — the greater/EQUAL horizontal check the
// upstream test's single-yellow-pixel probe pins: a WAIT for an horizontal
// position already passed on the current line releases immediately.
func TestRunToCycleWaitHorizontalGreaterEqual(t *testing.T) {
	c := New()
	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	loadWords(c, []uint16{
		waitWord(16, 140), // releases at hcount 140 on line 140
		moveWord(0x41, 0x0E),
		waitWord(0, 140), // h threshold 12 — ALREADY passed: releases at once
		moveWord(0x41, 0xB6),
		waitWord(0, 141),
	})
	c.SetWritePtrHighAndMode(byte(StartOnVBL) << 6)
	// Up to hcount 139 (cycle 559): nothing released.
	c.RunToCycle(140, 139*CyclesPerHcount+3)
	if len(rw.writes) != 0 {
		t.Fatalf("WAIT released before its hcount threshold: %v", rw.writes)
	}
	// Reaching hcount 140 releases the first WAIT, and the h=0 WAIT (its
	// threshold long passed) releases in the same stream.
	c.RunToCycle(140, 141*CyclesPerHcount)
	if len(rw.writes) != 2 {
		t.Fatalf("h>= release chain: %d writes, want 2 (%v)", len(rw.writes), rw.writes)
	}
}

// MOVE costs 2 cycles and NOP 1 (copper.vhd:87-110), so back-to-back MOVEs
// land half a pixel (2 of 4 cycles) apart: within one pixel's 4-cycle
// window, exactly two MOVEs execute.
func TestRunToCycleMovePacing(t *testing.T) {
	c := New()
	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	words := []uint16{waitWord(2, 5)} // releases at hcount 28 = cycle 112
	for i := 0; i < 6; i++ {
		words = append(words, moveWord(0x41, byte(i)))
	}
	loadWords(c, words)
	c.SetWritePtrHighAndMode(byte(StartOnVBL) << 6)
	// Through the end of the release pixel (hcount 28, cycles 112..115):
	// the WAIT's release check (1 cycle) + two 2-cycle MOVEs fit.
	c.RunToCycle(5, 28*CyclesPerHcount+3)
	if len(rw.writes) != 2 {
		t.Fatalf("MOVEs within the release pixel = %d, want 2 (%v)", len(rw.writes), rw.writes)
	}
	// Each further pixel admits two more MOVEs.
	c.RunToCycle(5, 29*CyclesPerHcount+3)
	if len(rw.writes) != 4 {
		t.Fatalf("MOVEs after one more pixel = %d, want 4", len(rw.writes))
	}
}

// A HALTed ($FFFF) list restarts at the frame origin in StartOnVBL mode —
// the FPGA resets the list address at vcount==0 && hcount==0 (copper.vhd:80-83);
// HALT itself is only an unsatisfiable WAIT, not a latched stop.
func TestRunToCycleHaltRestartsOnVBL(t *testing.T) {
	c := New()
	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	loadWords(c, []uint16{
		moveWord(0x41, 0xAA),
		0xFFFF, // HALT
	})
	c.SetWritePtrHighAndMode(byte(StartOnVBL) << 6)
	c.RunToCycle(0, 1791)
	c.RunToCycle(100, 1791) // parked on HALT
	if len(rw.writes) != 1 {
		t.Fatalf("frame 1: %d writes, want 1", len(rw.writes))
	}
	c.RunToCycle(0, 1791) // raster wrapped: list restarts past the HALT
	if len(rw.writes) != 2 {
		t.Fatalf("HALT survived the VBL restart: %d writes, want 2", len(rw.writes))
	}
}
