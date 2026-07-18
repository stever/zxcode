package copper

import "testing"

type fakeRegWriter struct {
	writes []struct{ reg, val byte }
}

func (f *fakeRegWriter) WriteReg(reg, val byte) {
	f.writes = append(f.writes, struct{ reg, val byte }{reg, val})
}

func TestDecodeMOVE(t *testing.T) {
	w := uint16(0x4255) // bit 15 = 0; reg 0x42; val 0x55
	got := Decode(w)
	if got.Op != OpMOVE || got.Reg != 0x42 || got.Val != 0x55 {
		t.Errorf("Decode(0x4255) = %+v, want MOVE reg=0x42 val=0x55", got)
	}
}

func TestDecodeWAIT(t *testing.T) {
	// bit 15 = 1; x = 4 (in bits 14-9); y = 100 (in bits 8-0)
	w := uint16(0x8000) | (uint16(4) << 9) | 100
	got := Decode(w)
	if got.Op != OpWAIT || got.X != 4 || got.Y != 100 {
		t.Errorf("Decode WAIT 4/100 = %+v", got)
	}
}

func TestDecodeHALT(t *testing.T) {
	if Decode(0xFFFF).Op != OpHALT {
		t.Errorf("0xFFFF should decode as HALT")
	}
}

func TestDecodeNOOP(t *testing.T) {
	if Decode(0x0000).Op != OpNOOP {
		t.Errorf("0x0000 should decode as NOOP")
	}
}

func TestWriteDataLatchesPair(t *testing.T) {
	c := New()
	// The NR$61 cursor is a BYTE address (zxnext.vhd:5426): byte $10
	// is the high half of instruction $10>>1 = 8.
	c.SetWritePtrLow(0x10)
	c.WriteData(0x42) // high byte (even address)
	c.WriteData(0x55) // low byte (odd address)
	if got := c.Instruction(0x08); got.Op != OpMOVE || got.Reg != 0x42 || got.Val != 0x55 {
		t.Errorf("instruction[0x08] = %+v, want MOVE 0x42/0x55", got)
	}
	if c.Cursor() != 0x12 {
		t.Errorf("Cursor = %#x, want 0x12 (one byte per NR$60 write)", c.Cursor())
	}
}

// TestWriteDataOddAddressPatchesLowByte pins the NR$60 write-8 path
// (zxnext.vhd:3977): a cursor moved onto an ODD byte address writes
// just the low half of that instruction, leaving the high half.
func TestWriteDataOddAddressPatchesLowByte(t *testing.T) {
	c := New()
	c.WriteData(0x07) // instruction 0 high
	c.WriteData(0x10) // instruction 0 low
	c.SetWritePtrLow(0x01)
	c.WriteData(0x99) // patch low byte only
	if got := c.Instruction(0); got.Reg != 0x07 || got.Val != 0x99 {
		t.Errorf("instruction[0] = %+v, want MOVE 0x07/0x99", got)
	}
}

// TestWriteData16CommitsAtomically pins the NR$63 (16-bit port)
// staging: the even byte lands in nr_copper_data_stored and nothing
// reaches instruction memory until the odd byte commits the pair
// (zxnext.vhd:5432-5437).
func TestWriteData16CommitsAtomically(t *testing.T) {
	c := New()
	c.WriteData16(0x07)
	if got := c.Instruction(0); got.Op != OpNOOP {
		t.Errorf("instruction[0] committed after one NR$63 byte: %+v", got)
	}
	if c.Cursor() != 1 {
		t.Errorf("Cursor = %#x, want 1 (NR$63 advances per byte)", c.Cursor())
	}
	c.WriteData16(0x22)
	if got := c.Instruction(0); got.Op != OpMOVE || got.Reg != 0x07 || got.Val != 0x22 {
		t.Errorf("instruction[0] = %+v, want MOVE 0x07/0x22", got)
	}
}

func TestStartFromZeroRunsProgram(t *testing.T) {
	c := New()
	// MOVE reg 0x07, val 0x02 at index 0.
	c.SetWritePtrLow(0)
	c.WriteData(0x07)
	c.WriteData(0x02)
	// HALT at index 1.
	c.WriteData(0xFF)
	c.WriteData(0xFF)

	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	// Start from zero (mode 1).
	c.SetWritePtrHighAndMode(byte(StartFromZero) << 6)
	// Budget 4 cycles: the MOVE (2 cycles) executes and the copper
	// parks on the HALT.
	c.Step(0, 0, 4)

	if len(rw.writes) != 1 || rw.writes[0].reg != 0x07 || rw.writes[0].val != 0x02 {
		t.Errorf("MOVE not executed: writes = %+v", rw.writes)
	}
	// HALT parks (a WAIT that can never be satisfied) — further Steps
	// execute nothing.
	c.Step(0, 511, 64)
	if len(rw.writes) != 1 {
		t.Errorf("HALT should park the copper; extra writes = %+v", rw.writes[1:])
	}
}

func TestWaitParksUntilRasterReached(t *testing.T) {
	c := New()
	// WAIT y=100, x=0 at index 0.
	wait := uint16(0x8000) | 100
	c.SetWritePtrLow(0)
	c.WriteData(byte(wait >> 8))
	c.WriteData(byte(wait))
	// MOVE 0x07, 0x03 at index 1.
	c.WriteData(0x07)
	c.WriteData(0x03)
	// HALT at index 2 — without it the empty rest of the 1024-entry
	// list free-runs as NOOPs, wraps (10-bit counter), and re-releases
	// the WAIT on the same line within a full line budget: the MOVE
	// would faithfully fire again ~1025 cycles later.
	c.WriteData(0xFF)
	c.WriteData(0xFF)

	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	c.SetWritePtrHighAndMode(byte(StartFromZero) << 6)

	// Step at scanline 50 with a full line budget — not yet WAIT 100's
	// line (strict vcount equality, copper.vhd:94).
	c.Step(50, 455, 456*CyclesPerHcount)
	if len(rw.writes) != 0 {
		t.Errorf("MOVE fired before WAIT was satisfied: writes = %+v", rw.writes)
	}

	// Step at scanline 100, end-of-line hcount (455, zxula_timing.vhd:196)
	// with the line's cycle budget — WAIT released, MOVE executes in the
	// cycles remaining after the release position.
	c.Step(100, 455, 456*CyclesPerHcount)
	if len(rw.writes) != 1 || rw.writes[0].reg != 0x07 || rw.writes[0].val != 0x03 {
		t.Errorf("MOVE not executed after WAIT released: writes = %+v", rw.writes)
	}
}

func TestStartStopDoesntRun(t *testing.T) {
	c := New()
	c.WriteData(0x07)
	c.WriteData(0x02)
	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	c.SetWritePtrHighAndMode(byte(StartStop) << 6)
	c.Step(0, 0, 4)
	if len(rw.writes) != 0 {
		t.Errorf("StartStop should keep copper halted; writes = %+v", rw.writes)
	}
}

// TestStepMaxInstrLimitsExecution pins the per-call instruction
// budget: with three MOVEs in the program, Step(_,_,1) executes
// exactly one of them.
func TestStepMaxInstrLimitsExecution(t *testing.T) {
	c := New()
	// Three MOVEs at indexes 0..2.
	for i := 0; i < 3; i++ {
		c.WriteData(0x07)
		c.WriteData(byte(0x10 + i))
	}
	rw := &fakeRegWriter{}
	c.SetRegWriter(rw)
	c.SetWritePtrHighAndMode(byte(StartFromZero) << 6)

	// Step with budget=1 — should execute exactly the first MOVE.
	c.Step(0, 0, 1)
	if len(rw.writes) != 1 || rw.writes[0].val != 0x10 {
		t.Errorf("Step(_,_,1) executed %d MOVEs, want exactly 1; first val = %#x, want 0x10",
			len(rw.writes), rw.writes[0].val)
	}
	// Step again — second MOVE.
	c.Step(0, 0, 1)
	if len(rw.writes) != 2 || rw.writes[1].val != 0x11 {
		t.Errorf("second Step: expected 2 MOVEs total; got %+v", rw.writes)
	}
}

// TestMOVEIntoCopperOwnRegistersDoesNotCrash exercises the
// re-entrant case where a MOVE instruction targets the Copper's
// own data / control registers. In production, the shared NextReg
// dispatcher is the RegWriter, so a MOVE to 0x60
// re-enters the Copper's WriteData via the dispatcher's OnWrite
// callback. The guard is that Step doesn't reload pc / mode
// fields mid-loop; this test pins that nothing crashes and the
// outer Step's pc advances normally.
type reentrantWriter struct {
	c *Copper
}

func (r *reentrantWriter) WriteReg(reg, val byte) {
	// Simulate dispatcher → Copper handler re-entry for 0x60.
	if reg == 0x60 {
		r.c.WriteData(val)
	}
}

func TestMOVEIntoCopperOwnRegistersDoesNotCrash(t *testing.T) {
	c := New()
	// Program at index 0: MOVE 0x60, 0xAB (re-enters); HALT.
	c.WriteData(0x60)
	c.WriteData(0xAB)
	c.WriteData(0xFF)
	c.WriteData(0xFF)

	c.SetRegWriter(&reentrantWriter{c: c})
	c.SetWritePtrHighAndMode(byte(StartFromZero) << 6)

	// Step with budget 4. MOVE fires, calls reentrantWriter
	// which calls c.WriteData (mutating writePtr) — does NOT
	// disturb the outer Step's pc.
	c.Step(0, 0, 4)
	if c.pc != 1 {
		t.Errorf("Copper should have run MOVE then parked on HALT; pc = %d, want 1", c.pc)
	}
}

func TestCursorWraps(t *testing.T) {
	c := New()
	c.SetWritePtrLow(0xFF)
	c.SetWritePtrHighAndMode(0x07) // address bits 10:8 all set → byte $7FF
	if c.Cursor() != 0x7FF {
		t.Errorf("Cursor after high-write = %#x, want 0x7FF", c.Cursor())
	}
	// Write past the 2 KB end — the 11-bit byte address wraps.
	c.WriteData(0x00) // low byte of the last instruction; $7FF+1 wraps to 0
	if c.Cursor() != 0 {
		t.Errorf("Cursor after wrap = %#x, want 0", c.Cursor())
	}
}

// TestDecodeMOVE_RegMaskedTo7Bits verifies the 7-bit NextReg index
// in MOVE (bits 14:8) is masked to 0..127 — bit 15 distinguishes
// MOVE vs WAIT, so it can never appear in Reg.
func TestDecodeMOVE_RegMaskedTo7Bits(t *testing.T) {
	w := uint16(0x7F55) // bit 15=0, bits 14:8=0x7F, value=0x55
	got := Decode(w)
	if got.Op != OpMOVE || got.Reg != 0x7F {
		t.Errorf("Decode($7F55) = %+v, want MOVE reg=$7F val=$55", got)
	}
}

// TestDecodeWAIT_AllZeroXY is a corner case: a WAIT (0,0) at boot
// would never satisfy because the copper starts past the position.
func TestDecodeWAIT_AllZeroXY(t *testing.T) {
	w := uint16(0x8000) // bit 15 = 1, x=0, y=0
	got := Decode(w)
	if got.Op != OpWAIT || got.X != 0 || got.Y != 0 {
		t.Errorf("Decode($8000) = %+v, want WAIT 0/0", got)
	}
}

// TestDecodeWAIT_MaxX verifies bits 14:9 (6 bits) decode 0..63.
func TestDecodeWAIT_MaxX(t *testing.T) {
	// x=63, y=511 — the HALT-encoded WAIT 0xFFFF.
	got := Decode(0xFFFF)
	// 0xFFFF is explicitly HALT.
	if got.Op != OpHALT {
		t.Errorf("$FFFF Op = %v, want HALT (encoded WAIT max)", got.Op)
	}
	// x=63, y=510 → not HALT.
	w := uint16(0x8000) | (uint16(63) << 9) | 510
	got = Decode(w)
	if got.Op != OpWAIT || got.X != 63 || got.Y != 510 {
		t.Errorf("Decode max-x = %+v, want WAIT 63/510", got)
	}
}

// TestSetWritePtrLow_KeepsHighBits verifies that writing the low
// byte preserves the high 2 cursor bits set via NR$62.
func TestSetWritePtrLow_KeepsHighBits(t *testing.T) {
	c := New()
	c.SetWritePtrHighAndMode(0x02) // bits 0-1 = high cursor, value 2 → high=$02 = 2
	if c.Cursor() != 0x200 {
		t.Fatalf("after HighAndMode($02): cursor = %#x, want $200", c.Cursor())
	}
	c.SetWritePtrLow(0x55)
	if c.Cursor() != 0x255 {
		t.Errorf("after Low($55): cursor = %#x, want $255 (high bits preserved)",
			c.Cursor())
	}
}

// TestMode_MaskedToBits76 verifies SetWritePtrHighAndMode extracts
// mode from bits 7:6 only (bits 5:2 are reserved per docs).
func TestMode_MaskedToBits76(t *testing.T) {
	c := New()
	c.SetWritePtrHighAndMode(0x7F) // bits 7:6 = 01 (StartFromZero), all other bits set
	if c.Mode() != StartFromZero {
		t.Errorf("Mode after $7F: %v, want StartFromZero", c.Mode())
	}
	c.SetWritePtrHighAndMode(0xBF) // bits 7:6 = 10 (StartContinue)
	if c.Mode() != StartContinue {
		t.Errorf("Mode after $BF: %v, want StartContinue", c.Mode())
	}
}

// TestStartStop_HaltsCopper verifies StartStop mode (bits 7:6 = 00)
// halts the copper.
func TestStartStop_HaltsCopper(t *testing.T) {
	c := New()
	c.SetWritePtrHighAndMode(0x40) // bits 7:6 = 01, start from zero
	// Now stop.
	c.SetWritePtrHighAndMode(0x00) // bits 7:6 = 00, stop
	if c.Mode() != StartStop {
		t.Errorf("after StartStop write: Mode = %v, want StartStop", c.Mode())
	}
}

// TestNewCopper_StartsStopped — fresh Copper instance has stopped=true.
func TestNewCopper_StartsStopped(t *testing.T) {
	c := New()
	if c.Mode() != StartStop {
		t.Errorf("New Copper Mode = %v, want StartStop", c.Mode())
	}
}

// TestCursorSetResetsBytePhase locks in that setting the NR$61/$62 write cursor
// resets the NR$60 hi/lo byte-pairing phase. A stray odd byte staged before the
// cursor move (e.g. the dispatcher reset writing NR$60=$00) must NOT pair
// off-by-one with the following program stream — that turned NextZXOS's real
// copper list into garbage "MOVE NR$01..,$16" writes that clobbered the whole
// NextReg config and reset Nextoid to the Welcome screen.
func TestCursorSetResetsBytePhase(t *testing.T) {
	for _, via62 := range []bool{false, true} {
		c := New()
		c.WriteData(0x00) // stray staged hi byte (the reset write)
		if via62 {
			c.SetWritePtrHighAndMode(0x00) // cursor high + mode, must reset phase
			c.SetWritePtrLow(0x00)
		} else {
			c.SetWritePtrLow(0x00) // cursor low, must reset phase
		}
		// Program: WAIT line 0 (0x8000) then MOVE NR$16,$00 (0x1600).
		c.WriteData(0x80)
		c.WriteData(0x00)
		c.WriteData(0x16)
		c.WriteData(0x00)
		if got := c.Instruction(0); got.Op != OpWAIT || got.Y != 0 {
			t.Errorf("via62=%v: instruction[0]=%+v, want WAIT y=0 (cursor set must reset byte phase)", via62, got)
		}
		if got := c.Instruction(1); got.Op != OpMOVE || got.Reg != 0x16 || got.Val != 0x00 {
			t.Errorf("via62=%v: instruction[1]=%+v, want MOVE NR$16,$00", via62, got)
		}
	}
}

// TestFrameMoveInstantsAticPacer pins the NR$02 NMI-pacer schedule
// (#187): Atic Atac's free-running mode-01 list — 687 NOOPs, 336
// MOVE-NR$7F pads, final MOVE NR$02,$04 — wraps every 1361 copper
// cycles, so a 311-line frame at 1824 cycles/line must yield
// floor-ish(311*1824/1361) ≈ 416 NR$02 instants, each carrying $04.
// The simulation must also leave the real copper untouched.
func TestFrameMoveInstantsAticPacer(t *testing.T) {
	c := New()
	write16 := func(i int, w uint16) {
		c.SetWritePtrLow(byte((i * 2) & 0xFF))
		c.SetWritePtrHighAndMode(byte((i * 2) >> 8 & 0x07))
		c.WriteData16(byte(w >> 8))
		c.WriteData16(byte(w))
	}
	for i := 0; i < 687; i++ {
		write16(i, 0x0000) // NOOP
	}
	for i := 687; i < 1023; i++ {
		write16(i, 0x7F00) // MOVE NR$7F,$00 pad
	}
	write16(1023, 0x0204)          // MOVE NR$02,$04 — the divMMC NMI pulse
	c.SetWritePtrHighAndMode(0x40) // mode 01 = FromZero, run

	pcBefore := c.pc
	moves := c.FrameMoveInstants(0x02, 311, 1824)
	if c.pc != pcBefore {
		t.Fatalf("FrameMoveInstants mutated the real copper pc: %d -> %d", pcBefore, c.pc)
	}
	// 311*1824 = 567264 cycles; wrap cost = 687*1 + 337*2 = 1361.
	// Per-line budget quantization loses a fraction per line, so accept
	// a small band around the analytic 416.
	if len(moves) < 380 || len(moves) > 420 {
		t.Fatalf("pacer instants = %d, want ~416 (one per ~1361-cycle wrap)", len(moves))
	}
	for i, m := range moves {
		if m.Val != 0x04 {
			t.Fatalf("instant %d val = $%02X, want $04", i, m.Val)
		}
		if int(m.Line) >= 311 || m.Cycle < 0 || m.Cycle >= 1824+1361 {
			t.Fatalf("instant %d out of range: line=%d cycle=%d", i, m.Line, m.Cycle)
		}
	}
	// Stopped copper produces no schedule.
	c.SetWritePtrHighAndMode(0x00)
	if got := c.FrameMoveInstants(0x02, 311, 1824); len(got) != 0 {
		t.Fatalf("stopped copper produced %d instants, want 0", len(got))
	}
	if c.HasRunnableMoveTo(0x02) {
		t.Fatal("HasRunnableMoveTo should be false while stopped")
	}
}

// TestStartPhaseAnchor pins the stopped→running NR$62 start anchoring
// (#187): the FPGA copper begins executing on the 28 MHz cycle after
// the enable edge (copper.vhd:70-83 edge-detects copper_en on the
// free-running dot-clock lattice), so a list started mid-frame is
// phase-anchored to the WRITE instant, not the frame top. The model
// banks the frame's already-elapsed cycles as a stepCarry debt at the
// mode transition; both the render engines (Step / RunToCycle) and
// the NMI pacer's schedule sim (FrameMoveInstants resumes from
// linePos+stepCarry) consume it before executing the list. A
// free-running NMI-pacer wrap keeps this phase for its whole life.
func TestStartPhaseAnchor(t *testing.T) {
	const debt = 5000 // copper cycles already elapsed in the frame
	newList := func(phase func() int) *Copper {
		c := New()
		c.SetContinuousPacing(true)
		c.SetLineCycles(1824)
		c.SetStartPhaseSource(phase)
		// MOVE NR$02,$04 at index 0, HALT after: single instant at the
		// list start makes the anchored offset directly observable.
		c.SetWritePtrLow(0)
		c.WriteData16(0x02)
		c.WriteData16(0x04)
		c.WriteData16(0xFF)
		c.WriteData16(0xFF)
		c.SetWritePtrHighAndMode(0x40) // stopped → FromZero: start edge
		return c
	}

	// FrameMoveInstants: the single MOVE must land at the write instant
	// (debt cycles into the frame), +1 for the pulse-to-NMI-line cycle
	// accounted by the pacer, not here — the raw instant is the MOVE's
	// first cycle.
	c := newList(func() int { return debt })
	moves := c.FrameMoveInstants(0x02, 311, 1824)
	if len(moves) != 1 {
		t.Fatalf("instants = %d, want 1", len(moves))
	}
	if got := int(moves[0].Line)*1824 + moves[0].Cycle; got != debt {
		t.Fatalf("anchored instant = %d cycles, want %d (the NR$62 write instant)", got, debt)
	}

	// RunToCycle: the render's line drive must consume the same debt
	// before the MOVE executes — the write fires on line debt/1824 at
	// cycle debt%1824, not at the frame top.
	c2 := newList(func() int { return debt })
	var fired []int
	c2.SetRegWriter(regWriterFunc(func(reg, val byte) {
		if reg == 0x02 {
			fired = append(fired, 0)
		}
	}))
	for line := 0; line < 5; line++ {
		c2.RunToCycle(uint16(line), 1823)
		if len(fired) > 0 {
			wantLine := debt / 1824
			if line != wantLine {
				t.Fatalf("MOVE fired on line %d, want line %d (debt %d)", line, wantLine, debt)
			}
			return
		}
	}
	t.Fatalf("MOVE never fired within 5 lines (debt %d)", debt)
}

// regWriterFunc adapts a func to the RegWriter interface for tests.
type regWriterFunc func(reg, val byte)

func (f regWriterFunc) WriteReg(reg, val byte) { f(reg, val) }
