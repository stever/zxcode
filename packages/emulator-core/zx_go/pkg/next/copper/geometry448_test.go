package copper

// Engine pins for the 448-hcount timings (48K/Pentagon, c_max_hc = 447,
// zxula_timing.vhd:262/:160): both engines stay equivalent when driven
// with the live-geometry line length the compositor pass now supplies
// (Step's hcount/budget arguments + SetLineCycles for RunToCycle's
// line clock), and the WAIT wrap threshold moves with the line — X=55
// (release hcount 452) is reachable on a 456-hcount line but never on
// a 448-hcount one.

import (
	"fmt"
	"math/rand"
	"testing"
)

// runEnginesAt mirrors runStepEngine/runPacedEngine at an arbitrary
// line geometry and returns both engines' write streams.
func runEnginesAt(hcounts, lines int, prog []uint16, mode StartMode, frames int) (stepW, pacedW []eqWrite) {
	lineCycles := hcounts * CyclesPerHcount
	lineEnd := hcounts - 1

	cs := New()
	recS := &eqRecorder{}
	cs.SetRegWriter(recS)
	cs.SetLineCycles(lineCycles)
	loadProgram(cs, prog, mode)
	for f := 0; f < frames; f++ {
		for v := 0; v < lines; v++ {
			recS.line = f*1000 + v
			cs.Step(uint16(v), uint16(lineEnd), lineCycles)
		}
	}

	cp := New()
	recP := &eqRecorder{}
	cp.SetRegWriter(recP)
	cp.SetLineCycles(lineCycles)
	loadProgram(cp, prog, mode)
	for f := 0; f < frames; f++ {
		for v := 0; v < lines; v++ {
			recP.line = f*1000 + v
			for _, cyc := range []int{300, 901, 1500, lineCycles - 1, lineCycles - 1} {
				if cyc > lineCycles-1 {
					cyc = lineCycles - 1
				}
				cp.RunToCycle(uint16(v), cyc)
			}
		}
	}
	return recS.writes, recP.writes
}

func assertEquivalentAt(t *testing.T, name string, hcounts, lines int, prog []uint16, mode StartMode, frames int) {
	t.Helper()
	stepW, pacedW := runEnginesAt(hcounts, lines, prog, mode, frames)
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
			return
		}
	}
}

// TestCopperEngineEquivalence448 re-runs the directed shapes and a
// seeded random sweep on the 48K/Pentagon 448-hcount, 312-line frame.
func TestCopperEngineEquivalence448(t *testing.T) {
	aticShape := make([]uint16, 1024)
	aticShape[1023] = move(0x40, 0x01)
	descending := []uint16{
		wait(0, 100), move(0x41, 0xAA),
		wait(0, 50), move(0x41, 0xBB),
		halt,
	}
	// Tail thresholds around the 448-line wrap: X=54 (444) reachable,
	// X=55 (452) not.
	tail := []uint16{
		wait(54, 10), move(0x42, 0x01),
		wait(55, 20), move(0x42, 0x02),
		halt,
	}
	cases := []struct {
		name   string
		prog   []uint16
		mode   StartMode
		frames int
	}{
		{"atic-wrap-freerun-448", aticShape, StartFromZero, 2},
		{"descending-wait-448", descending, StartFromZero, 3},
		{"tail-thresholds-448", tail, StartFromZero, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assertEquivalentAt(t, tc.name, 448, 312, tc.prog, tc.mode, tc.frames)
		})
	}

	rng := rand.New(rand.NewSource(0x448))
	for i := 0; i < 20; i++ {
		prog := make([]uint16, 1+rng.Intn(48))
		for j := range prog {
			switch p := rng.Intn(100); {
			case p < 55:
				prog[j] = move(byte(1+rng.Intn(127)), byte(rng.Intn(256)))
			case p < 70:
				prog[j] = move(0, byte(rng.Intn(256)))
			case p < 96:
				prog[j] = wait(byte(rng.Intn(64)), uint16(rng.Intn(340)))
			default:
				prog[j] = halt
			}
		}
		mode := StartFromZero
		if i%2 == 1 {
			mode = StartOnVBL
		}
		name := fmt.Sprintf("seeded-448-%03d", i)
		t.Run(name, func(t *testing.T) {
			assertEquivalentAt(t, name, 448, 312, prog, mode, 3)
		})
	}
}

// TestWaitWrapThresholdPerLineLength pins the wrap boundary on both
// engines: WAIT X=55 releases (and its MOVE fires) on a 456-hcount
// line, and never on a 448-hcount line; X=54 fires on both.
func TestWaitWrapThresholdPerLineLength(t *testing.T) {
	prog := func(x byte) []uint16 { return []uint16{wait(x, 5), move(0x50, 0x01), halt} }
	countWrites := func(hcounts int, x byte) (step, paced int) {
		s, p := runEnginesAt(hcounts, 312, prog(x), StartFromZero, 2)
		return len(s), len(p)
	}
	for _, tc := range []struct {
		hcounts int
		x       byte
		want    int
	}{
		{456, 55, 1}, // threshold 452 <= c_max_hc 455: releases
		{448, 55, 0}, // threshold 452 > c_max_hc 447: parks forever
		{456, 54, 1},
		{448, 54, 1}, // threshold 444 <= 447: releases
	} {
		s, p := countWrites(tc.hcounts, tc.x)
		if s != tc.want || p != tc.want {
			t.Errorf("hcounts %d X=%d: Step %d writes, RunToCycle %d, want %d each",
				tc.hcounts, tc.x, s, p, tc.want)
		}
	}
}
