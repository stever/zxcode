package ula

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// Turbo-speed video timing (#180, Axis 10): mid-frame raster stamps
// (border changes, video-state flips) must ride the 3.5 MHz REFERENCE
// timeline, not the CPU-domain T-counter — at NR$07 turbo the CPU
// executes 2/4/8 T-states per reference T-state, so the old division
// stamped effects 2/4/8× too far down the frame. The FPGA's raster
// runs on its own clock regardless of CPU speed (zxula_timing.vhd).

// turboRasterStack builds a Next ULA whose clocks the test controls
// directly: cpuT is the CPU-domain frame counter, refT the reference
// timeline (frame origin 0).
func turboRasterStack(t *testing.T) (*ULA, *uint64, *uint64) {
	t.Helper()
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	var cpuT, refT uint64
	mem.TStates = &cpuT
	mem.RefTstates = func() uint64 { return refT }
	mem.FrameOriginRef = func() uint64 { return 0 }
	u := New(mem, keyboard.New())
	return u, &cpuT, &refT
}

// TestBorderStampSpeedIndependent: at 28 MHz (multiplier 8) the same
// raster moment carries an 8× CPU count — the border stamp must come
// from the reference line.
func TestBorderStampSpeedIndependent(t *testing.T) {
	u, cpuT, refT := turboRasterStack(t)
	var stamped int
	u.SetBorderTracer(func(_ uint16, _ byte, _ byte, scanline int) { stamped = scanline })

	// Raster at line 100; the CPU has burned 8× the reference T-states.
	*refT = 100 * TStatesPerLine
	*cpuT = 8 * 100 * TStatesPerLine
	u.WritePort(0x00FE, 0x02)
	if stamped != 100 {
		t.Errorf("border stamp at 28 MHz = line %d, want 100 (reference timeline)", stamped)
	}

	// Same raster line later in the frame at 14 MHz (multiplier 4).
	*refT = 250 * TStatesPerLine
	*cpuT = 4 * 250 * TStatesPerLine
	u.WritePort(0x00FE, 0x05)
	if stamped != 250 {
		t.Errorf("border stamp at 14 MHz = line %d, want 250", stamped)
	}
}

// TestVideoStateStampSpeedIndependent: the raster-stamped ULA video
// state (ULANext / palette-select / NR$15 / ULA+ flips) uses the same
// speed-independent clock.
func TestVideoStateStampSpeedIndependent(t *testing.T) {
	u, cpuT, refT := turboRasterStack(t)
	*refT = 60 * TStatesPerLine
	*cpuT = 8 * 60 * TStatesPerLine
	u.SetULANext(true, 0x07) // records a ulaVideoChange
	if n := len(u.ulaVideoChanges); n == 0 {
		t.Fatal("SetULANext recorded no video change")
	}
	if got := u.ulaVideoChanges[len(u.ulaVideoChanges)-1].scanline; got != 60 {
		t.Errorf("video-state stamp at 28 MHz = line %d, want 60 (reference timeline)", got)
	}
}

// TestBorderStampClassicFallback: without a reference clock (classic
// models — no turbo) the per-model CPU-clock division still applies.
func TestBorderStampClassicFallback(t *testing.T) {
	mem, err := memory.New("", roms.Model128K)
	if err != nil {
		t.Fatal(err)
	}
	var cpuT uint64
	mem.TStates = &cpuT
	u := New(mem, keyboard.New())
	var stamped int
	u.SetBorderTracer(func(_ uint16, _ byte, _ byte, scanline int) { stamped = scanline })
	cpuT = 80 * 228
	u.WritePort(0x00FE, 0x03)
	if stamped != 80 {
		t.Errorf("classic border stamp = line %d, want 80", stamped)
	}
}
