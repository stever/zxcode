package copper

import "testing"

// Mid-frame stop→start pair conformance (#205). TX-1696 rebuilds its
// per-band copper list EVERY frame: NR$62=$00 (stop) around raster
// line 194, ~512 NR$60 uploads, NR$62=$C0 (start, OnVBL) around line
// 203. On the FPGA the list runs from the frame top (VBL pc reset)
// until the stop, and the restart's own execution begins at the start
// instant — so the early-line band WAITs release every frame. Charging
// the whole head of the frame as start debt instead (the start-only
// #197 convention) deferred the program past those WAITs, whose strict
// same-line release then parked it for the entire pass: zero copper
// writes reached any displayed frame.

// pairProgram uploads: MOVE $40,$01 (preamble) / WAIT line 13 /
// MOVE $1B,$10 (the band write) / HALT.
func pairProgram(c *Copper) {
	c.SetWritePtrLow(0)
	for _, b := range []byte{
		0x40, 0x01, // MOVE NR$40,$01
		0x80, 0x0D, // WAIT line=13
		0x1B, 0x10, // MOVE NR$1B,$10
		0xFF, 0xFF, // HALT
	} {
		c.WriteData(b)
	}
}

func walkFrame(c *Copper) {
	for line := 0; line <= 310; line++ {
		c.Step(uint16(line), 455, 456*CyclesPerHcount)
	}
}

func countReg(rw *fakeRegWriter, reg byte) int {
	n := 0
	for _, w := range rw.writes {
		if w.reg == reg {
			n++
		}
	}
	return n
}

// TestMidFrameStopStartPairKeepsBands pins the fix: after a stop at
// line ~194 and a restart at line ~203 (the TX-1696 pattern), the NEXT
// frame's pass still executes the head of the list from the frame top,
// so the WAIT-13 band write lands. Pre-fix the start debt deferred the
// program to line 203 and the band write never ran again.
func TestMidFrameStopStartPairKeepsBands(t *testing.T) {
	line := 456 * CyclesPerHcount
	phase := 0
	c := New()
	c.SetContinuousPacing(true)
	c.SetStartPhaseSource(func() int { return phase })
	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	pairProgram(c)

	// Initial start at the frame top (no debt), one clean frame.
	c.SetWritePtrHighAndMode(byte(StartOnVBL) << 6)
	walkFrame(c)
	if got := countReg(rw, 0x1B); got != 1 {
		t.Fatalf("clean frame: band write ran %d times, want 1", got)
	}

	// The TX pattern: stop at line 194, restart at line 203.
	phase = 194 * line
	c.SetWritePtrHighAndMode(0x00) // stop — banks the instant
	phase = 203 * line
	c.SetWritePtrHighAndMode(byte(StartOnVBL) << 6) // start — arms the pair
	rw.writes = nil
	walkFrame(c)
	if got := countReg(rw, 0x1B); got != 1 {
		t.Errorf("post-pair frame: band write ran %d times, want 1 (head must run from the frame top)", got)
	}
	// The restart re-runs the preamble at the resume instant, then the
	// passed WAIT 13 parks it — so the preamble fires twice this frame
	// (head + post-restart), exactly like the FPGA's timeline.
	if got := countReg(rw, 0x40); got != 2 {
		t.Errorf("post-pair frame: preamble ran %d times, want 2 (head + restart)", got)
	}
}

// TestStartOnlyDebtStillDefers pins the #197 contract: a stopped→
// running start with NO preceding mid-frame stop keeps the pure debt
// behaviour — nothing executes before the write instant, so the passed
// WAIT 13 parks the list until the next frame.
func TestStartOnlyDebtStillDefers(t *testing.T) {
	line := 456 * CyclesPerHcount
	phase := 100 * line
	c := New()
	c.SetContinuousPacing(true)
	c.SetStartPhaseSource(func() int { return phase })
	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	pairProgram(c)

	c.SetWritePtrHighAndMode(byte(StartOnVBL) << 6) // start mid-frame, never ran before
	walkFrame(c)
	if got := countReg(rw, 0x1B); got != 0 {
		t.Errorf("start-only frame: band write ran %d times, want 0 (debt defers to line 100)", got)
	}
	if got := countReg(rw, 0x40); got != 1 {
		t.Errorf("start-only frame: preamble ran %d times, want 1 (at the write instant)", got)
	}
	// Next frame: VBL reset, the full program runs from the top.
	rw.writes = nil
	walkFrame(c)
	if got := countReg(rw, 0x1B); got != 1 {
		t.Errorf("frame after start-only: band write ran %d times, want 1", got)
	}
}
