package next

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/next/nextregs"
	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/z80"
)

// newFrameGeomRig wires the production NR$03/NR$05 geometry pipeline:
// WireMachineType (NR$03 write rules + timing mirror), WireJoystickMode
// (NR$05 storage), WireLineInterrupt and WireFrameGeometry chained on
// top, against a real ModelNext memory. The CPU INT fields are seeded
// with the boot values the way configureClassicIntTiming does.
func newFrameGeomRig(t *testing.T) (*nextregs.Dispatcher, *memory.Memory, *z80.CPU) {
	t.Helper()
	mem, err := memory.New(wireTestROMs(t), roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	cpu := z80.New(minimalMem{}, minimalULA{})
	assert, pulse, ok := FrameIntTimingForModel(roms.ModelNext, false)
	if !ok {
		t.Fatal("FrameIntTimingForModel(ModelNext) not ok")
	}
	cpu.IntAssertTstate = uint64(assert)
	cpu.IntPulseTstates = uint64(pulse)
	disp := nextregs.New()
	WireMachineType(disp, mem)
	WireCPUSpeed(disp, cpu)
	rec := WireLineInterrupt(disp, cpu, nil, mem)
	WireJoystickMode(disp)
	WireFrameGeometry(disp, mem, cpu, rec)
	return disp, mem, cpu
}

func writeNR(d *nextregs.Dispatcher, reg, val byte) {
	d.Select(reg)
	d.WriteData(val)
}

// The default path — a guest that never touches the timing — must keep
// every legacy constant: 70908 T frames of 228 T lines, INT at t=291
// for 32 T, contention anchor 14655, and the CPU fields untouched (so
// the pinned boot goldens cannot shift).
func TestWireFrameGeometryDefaultUnchanged(t *testing.T) {
	_, mem, cpu := newFrameGeomRig(t)
	if got := mem.FrameTStates(); got != 70908 {
		t.Errorf("FrameTStates = %d, want 70908", got)
	}
	if got := mem.NextGeometry().TStatesPerLine; got != 228 {
		t.Errorf("TStatesPerLine = %d, want 228", got)
	}
	if g := mem.NextGeometry(); g.PaperStartT != 14655 || g.Lines != 311 || g.MinVActive != 64 {
		t.Errorf("NextGeometry = %+v, want boot defaults", g)
	}
	if cpu.IntAssertTstate != 291 || cpu.IntPulseTstates != 32 {
		t.Errorf("CPU INT = (%d,%d), want (291,32)", cpu.IntAssertTstate, cpu.IntPulseTstates)
	}
	if cpu.StepFrameTstates != 0 {
		t.Errorf("StepFrameTstates = %d, want 0 (never pushed)", cpu.StepFrameTstates)
	}
}

// A same-geometry NR$03 rewrite (NextZXOS writes $03=$B0 post-boot as a
// pure timing refresh) must not re-push the CPU fields — the
// ZX_GO_INT_ASSERT frame-origin sweep override relies on surviving
// boot-time no-op writes.
func TestWireFrameGeometryNoopWriteKeepsCPUOverride(t *testing.T) {
	disp, _, cpu := newFrameGeomRig(t)
	cpu.IntAssertTstate = 12345 // simulate the debug override
	writeNR(disp, 0x03, 0xB0)   // timing stays +3
	if cpu.IntAssertTstate != 12345 {
		t.Errorf("no-op NR$03 write clobbered IntAssertTstate: %d", cpu.IntAssertTstate)
	}
}

// NR$03 with bit 7 set retunes the machine timing (zxnext.vhd:5124):
// 48K timing selects the 448-hcount 312-line frame
// (zxula_timing.vhd:252-278) — 69888 T frames of 224 T lines, INT at
// t=58 for 32 T, contention paper anchor (64*448+116)/2 = 14394.
func TestWireFrameGeometryRetunes48K(t *testing.T) {
	disp, mem, cpu := newFrameGeomRig(t)
	writeNR(disp, 0x03, 0x91) // bit7 + timing 001 (48K)
	if got := mem.FrameTStates(); got != 69888 {
		t.Errorf("FrameTStates = %d, want 69888", got)
	}
	if got := mem.NextGeometry().TStatesPerLine; got != 224 {
		t.Errorf("TStatesPerLine = %d, want 224", got)
	}
	if g := mem.NextGeometry(); g.Lines != 312 || g.MinVActive != 64 || g.PaperStartT != 14394 {
		t.Errorf("NextGeometry = %+v, want 48K 50Hz row", g)
	}
	if cpu.IntAssertTstate != 58 || cpu.IntPulseTstates != 32 {
		t.Errorf("CPU INT = (%d,%d), want (58,32)", cpu.IntAssertTstate, cpu.IntPulseTstates)
	}
	if cpu.StepFrameTstates != 69888 {
		t.Errorf("StepFrameTstates = %d, want 69888", cpu.StepFrameTstates)
	}
}

// NR$05 bit 2 selects 60 Hz (zxnext.vhd:5838): under the boot +3
// timing that is the 264-line frame (zxula_timing.vhd:216-244) —
// 60192 T, INT at c_int_h/2 = 63, paper top at min_vactive 40.
func TestWireFrameGeometryRetunes60Hz(t *testing.T) {
	disp, mem, cpu := newFrameGeomRig(t)
	writeNR(disp, 0x05, 0x04)
	if got := mem.FrameTStates(); got != 60192 {
		t.Errorf("FrameTStates = %d, want 60192", got)
	}
	if g := mem.NextGeometry(); g.Lines != 264 || g.MinVActive != 40 {
		t.Errorf("NextGeometry = %+v, want +3 60Hz row", g)
	}
	if cpu.IntAssertTstate != 63 || cpu.IntPulseTstates != 32 {
		t.Errorf("CPU INT = (%d,%d), want (63,32)", cpu.IntAssertTstate, cpu.IntPulseTstates)
	}
	// And back to 50 Hz.
	writeNR(disp, 0x05, 0x00)
	if got := mem.FrameTStates(); got != 70908 {
		t.Errorf("back to 50Hz: FrameTStates = %d, want 70908", got)
	}
	if cpu.IntAssertTstate != 291 {
		t.Errorf("back to 50Hz: IntAssertTstate = %d, want 291", cpu.IntAssertTstate)
	}
}

// Pentagon timing is always 50 Hz: the FPGA holds the stored NR$05
// 50/60 flag at 0 while Pentagon timing is selected
// (zxnext.vhd:5834-5836), so 60 Hz does not survive a trip through
// Pentagon timing and the flag reads back clear.
func TestWireFrameGeometryPentagonForces50Hz(t *testing.T) {
	disp, mem, cpu := newFrameGeomRig(t)
	writeNR(disp, 0x05, 0x04) // 60 Hz first
	writeNR(disp, 0x03, 0xC0) // bit7 + timing 100 (Pentagon)
	if got := mem.FrameTStates(); got != 71680 {
		t.Errorf("Pentagon: FrameTStates = %d, want 71680", got)
	}
	if cpu.IntAssertTstate != 71675 || cpu.IntPulseTstates != 36 {
		t.Errorf("Pentagon: CPU INT = (%d,%d), want (71675,36)",
			cpu.IntAssertTstate, cpu.IntPulseTstates)
	}
	if disp.Raw(0x05)&0x04 != 0 {
		t.Errorf("Pentagon: stored NR$05 bit 2 should be forced 0")
	}
	// NR$05 writes under Pentagon cannot set the flag either.
	writeNR(disp, 0x05, 0x04)
	if disp.Raw(0x05)&0x04 != 0 {
		t.Errorf("Pentagon: NR$05 write re-set bit 2")
	}
	if got := mem.FrameTStates(); got != 71680 {
		t.Errorf("Pentagon ignores 50/60: FrameTStates = %d, want 71680", got)
	}
	// Leaving Pentagon lands on 50 Hz (the flag was cleared).
	writeNR(disp, 0x03, 0xB0) // timing 011 (+3)
	if got := mem.FrameTStates(); got != 70908 {
		t.Errorf("after Pentagon: FrameTStates = %d, want 70908 (50 Hz)", got)
	}
}

// A timing retune re-derives a programmed NR$22/$23 line interrupt
// from the new geometry: line length 228→224 and the min_vactive
// paper offset both follow the live row.
func TestWireFrameGeometryRecomputesLineInt(t *testing.T) {
	disp, _, cpu := newFrameGeomRig(t)
	writeNR(disp, 0x23, 100)
	writeNR(disp, 0x22, 0x02) // enable
	if want := uint64(100-1+64) * 228; cpu.LineIntOffsetTstates != want {
		t.Fatalf("precondition: LineIntOffsetTstates = %d, want %d",
			cpu.LineIntOffsetTstates, want)
	}
	writeNR(disp, 0x03, 0x91) // 48K timing: 224 T lines
	if want := uint64(100-1+64) * 224; cpu.LineIntOffsetTstates != want {
		t.Errorf("after 48K retune: LineIntOffsetTstates = %d, want %d",
			cpu.LineIntOffsetTstates, want)
	}
	writeNR(disp, 0x05, 0x04) // 48K 60 Hz: min_vactive 40, 264 lines
	if want := uint64((40+99)%264) * 224; cpu.LineIntOffsetTstates != want {
		t.Errorf("after 60Hz retune: LineIntOffsetTstates = %d, want %d",
			cpu.LineIntOffsetTstates, want)
	}
}

// The contention paper window follows the retuned geometry: under 48K
// timing the Next's window opens at t=14394 on 224 T lines (see
// memory.contentionDelay; anchor = (c_min_vactive*(c_max_hc+1) +
// c_int_h)/2 from zxula_timing.vhd:252-278).
func TestWireFrameGeometryContentionAnchorFollows(t *testing.T) {
	disp, mem, _ := newFrameGeomRig(t)
	var tstates uint64
	mem.SetTStatePtr(&tstates)
	// Bank 5 at $4000 contends in 48K timing (zxnext.vhd:4490-4494).
	writeNR(disp, 0x03, 0x91)

	probe := func(t uint64) uint64 {
		tstates = t
		before := tstates
		mem.ContendMemory(0x4000)
		return tstates - before
	}
	if d := probe(14393); d != 0 {
		t.Errorf("t=14393 (before 48K paper window): delay %d, want 0", d)
	}
	if d := probe(14394); d != 6 {
		t.Errorf("t=14394 (48K paper window opens): delay %d, want 6", d)
	}
	// Second line starts one 224-T line later.
	if d := probe(14394 + 224); d != 6 {
		t.Errorf("t=%d (48K paper line 1): delay %d, want 6", 14394+224, d)
	}
}
