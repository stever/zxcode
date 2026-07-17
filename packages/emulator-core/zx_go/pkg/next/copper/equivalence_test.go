package copper

// Step-vs-RunToCycle equivalence (#179): the machine drives one of two
// copper engines — the per-scanline functional Step (the non-live
// render flow) or the cycle-paced RunToCycle (the live-ULA per-pixel
// interleave). The #167 Atic Atac list-wrap bug lived in ONE of them;
// this test kills that class of drift structurally by driving both
// engines over the same programs and the same raster sweep and
// asserting they produce the identical per-line NextReg write
// sequence.
//
// Granularity: Step's contract is per-line (a caller passes the
// end-of-line hcount), so the comparison keys each write to its raster
// line. RunToCycle is exercised with mid-line intermediate targets to
// prove the incremental pacing sums to the same per-line effect.

import (
	"fmt"
	"math/rand"
	"testing"
)

// eqWrite is one recorded MOVE effect: which line it landed on
// (frame*1000+vcount so multi-frame runs stay ordered) plus the
// register/value pair.
type eqWrite struct {
	line     int
	reg, val byte
}

type eqRecorder struct {
	writes []eqWrite
	line   int
}

func (r *eqRecorder) WriteReg(reg, val byte) {
	r.writes = append(r.writes, eqWrite{line: r.line, reg: reg, val: val})
}

// eqFrameLines/eqLineHcounts match the Next's fixed 128K/+3 raster:
// 311 lines (c_max_vc = 310) of 456 hcounts (c_max_hc = 455,
// zxula_timing.vhd:196) — the same geometry pkg/ula's compositor pass
// drives both engines with. A WAIT threshold above 455 (X >= 56)
// never releases, exactly like the hardware.
const (
	eqFrameLines  = 311
	eqLineHcounts = 456
	eqLineEnd     = eqLineHcounts - 1
	eqLineCycles  = eqLineHcounts * CyclesPerHcount
)

// loadProgram stages a program through the public NR$61/$62/$63
// interface and starts it in the given mode.
func loadProgram(c *Copper, prog []uint16, mode StartMode) {
	c.SetWritePtrLow(0)
	c.SetWritePtrHighAndMode(0)
	for _, w := range prog {
		c.WriteData16(byte(w >> 8))
		c.WriteData16(byte(w))
	}
	c.SetWritePtrHighAndMode(byte(mode) << 6)
}

// runStepEngine sweeps `frames` frames through the per-scanline Step
// engine, the way pkg/ula's non-live flow drives it.
func runStepEngine(prog []uint16, mode StartMode, frames int) []eqWrite {
	c := New()
	rec := &eqRecorder{}
	c.SetRegWriter(rec)
	loadProgram(c, prog, mode)
	for f := 0; f < frames; f++ {
		for v := 0; v < eqFrameLines; v++ {
			rec.line = f*1000 + v
			c.Step(uint16(v), eqLineEnd, eqLineCycles)
		}
	}
	return rec.writes
}

// runPacedEngine sweeps the same frames through the cycle-paced
// RunToCycle engine, with intermediate mid-line targets so the
// incremental pacing (the live-ULA per-pixel pattern) is exercised,
// ending each line at the line-end cycle like the compositor pass.
func runPacedEngine(prog []uint16, mode StartMode, frames int) []eqWrite {
	c := New()
	rec := &eqRecorder{}
	c.SetRegWriter(rec)
	loadProgram(c, prog, mode)
	for f := 0; f < frames; f++ {
		for v := 0; v < eqFrameLines; v++ {
			rec.line = f*1000 + v
			for _, cyc := range []int{300, 901, 1500, eqLineCycles - 1, eqLineCycles - 1} {
				c.RunToCycle(uint16(v), cyc)
			}
		}
	}
	return rec.writes
}

func assertEquivalent(t *testing.T, name string, prog []uint16, mode StartMode, frames int) {
	t.Helper()
	stepW := runStepEngine(prog, mode, frames)
	pacedW := runPacedEngine(prog, mode, frames)
	if len(stepW) != len(pacedW) {
		t.Errorf("%s: Step made %d writes, RunToCycle %d", name, len(stepW), len(pacedW))
	}
	n := len(stepW)
	if len(pacedW) < n {
		n = len(pacedW)
	}
	for i := 0; i < n; i++ {
		if stepW[i] != pacedW[i] {
			t.Errorf("%s: write %d diverges: Step {line %d NR$%02X=$%02X} vs RunToCycle {line %d NR$%02X=$%02X}",
				name, i,
				stepW[i].line, stepW[i].reg, stepW[i].val,
				pacedW[i].line, pacedW[i].reg, pacedW[i].val)
			return // first divergence is the story; the rest is noise
		}
	}
}

// move encodes MOVE reg,val; wait encodes WAIT x,y per copper.vhd.
func move(reg, val byte) uint16 { return uint16(reg&0x7F)<<8 | uint16(val) }
func wait(x byte, y uint16) uint16 {
	return 0x8000 | uint16(x&0x3F)<<9 | y&0x01FF
}

const halt = 0xFFFF

// TestCopperEngineEquivalenceDirected pins the directed shapes: the
// Atic Atac free-running wrap, WAIT ladders (including a DESCENDING
// ladder whose second WAIT's line has already passed — strict
// equality parks it to the next frame, copper.vhd:94), HALT parking
// with the VBL restart, and an out-of-range park target.
func TestCopperEngineEquivalenceDirected(t *testing.T) {
	// Atic Atac's sample pacer shape: 1023 pad NOOPs + one MOVE, mode
	// 01 free-run — the list wraps its 10-bit counter forever.
	aticShape := make([]uint16, 1024)
	aticShape[1023] = move(0x40, 0x01)

	// Descending WAIT ladder: WAIT line 100 releases on line 100; the
	// following WAIT line 50 has PASSED — the copper parks until next
	// frame's line 50 (strict vcount equality, copper.vhd:94).
	descending := []uint16{
		wait(0, 100), move(0x41, 0xAA),
		wait(0, 50), move(0x41, 0xBB),
		halt,
	}

	// Ascending ladder with hpos thresholds inside the line.
	ladder := []uint16{
		wait(2, 10), move(0x42, 0x01),
		wait(40, 10), move(0x42, 0x02),
		wait(0, 11), move(0x42, 0x03),
		wait(63, 200), move(0x42, 0x04),
		halt,
	}

	// HALT parks; StartOnVBL un-parks each frame.
	vblRestart := []uint16{
		wait(0, 5), move(0x43, 0x11), halt,
	}

	// WAIT for a line the frame never reaches: parks forever.
	neverLine := []uint16{
		move(0x44, 0x01), wait(0, 400), move(0x44, 0x02),
	}

	cases := []struct {
		name   string
		prog   []uint16
		mode   StartMode
		frames int
	}{
		{"atic-wrap-freerun", aticShape, StartFromZero, 2},
		{"descending-wait-strict-equality", descending, StartFromZero, 3},
		{"ascending-ladder", ladder, StartFromZero, 2},
		{"halt-vbl-restart", vblRestart, StartOnVBL, 3},
		{"halt-no-vbl-stays-parked", vblRestart, StartFromZero, 3},
		{"wait-never-reached", neverLine, StartFromZero, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assertEquivalent(t, tc.name, tc.prog, tc.mode, tc.frames)
		})
	}
}

// TestCopperEngineEquivalenceRandom drives both engines over seeded
// random programs: MOVE/NOOP/WAIT mixes, occasional HALT, WAIT lines
// both inside and past the frame, full-length lists that wrap.
func TestCopperEngineEquivalenceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(0x5EED))
	for i := 0; i < 60; i++ {
		length := 1 + rng.Intn(48)
		if i%10 == 9 {
			length = MaxInstructions // full list: exercises the wrap
		}
		prog := make([]uint16, length)
		for j := range prog {
			switch p := rng.Intn(100); {
			case p < 55:
				prog[j] = move(byte(1+rng.Intn(127)), byte(rng.Intn(256)))
			case p < 70:
				prog[j] = move(0, byte(rng.Intn(256))) // NOOP (reg field 0)
			case p < 96:
				// WAIT: mostly in-frame lines, some past the frame end.
				y := uint16(rng.Intn(340))
				prog[j] = wait(byte(rng.Intn(64)), y)
			default:
				prog[j] = halt
			}
		}
		mode := StartFromZero
		if i%2 == 1 {
			mode = StartOnVBL
		}
		name := fmt.Sprintf("seeded-%03d", i)
		t.Run(name, func(t *testing.T) {
			assertEquivalent(t, name, prog, mode, 3)
		})
	}
}
