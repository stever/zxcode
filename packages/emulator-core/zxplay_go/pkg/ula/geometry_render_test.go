package ula

// Render-side pins for the live NR$03/$05 frame geometry (the Axis 10
// "per-NR$03/$05 display geometry" row): the copper interleave's line
// clock, the WAIT wrap threshold and the raster-stamp row map all
// follow the geometry mirror instead of the fixed 128K-flavour
// 456-hcount/311-line/paper-top-64 canvas.
//
// Geometry rows used here (zxula_timing.vhd constant table via
// next.FrameGeometryFor; values inlined because pkg/next imports
// pkg/ula):
//   48K 50 Hz:  224 T/line (448 hcounts), 312 lines, paper top 64,
//               contention anchor 14394
//   128K 60 Hz: 228 T/line (456 hcounts), 264 lines, paper top 40,
//               contention anchor 9183

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/memory"
)

var geo48K50Hz = memory.NextFrameGeometry{
	TStatesPerLine: 224, Lines: 312, MinVActive: 64, PaperStartT: 14394,
}

var geo128K60Hz = memory.NextFrameGeometry{
	TStatesPerLine: 228, Lines: 264, MinVActive: 40, PaperStartT: 9183,
}

// TestCopperInterleaveAnchorTimingIndependent pins that the copper's
// display anchor does NOT move with the line length: the copper's
// hcount input is hc_ula, the ULA-anchored counter (reset at
// c_min_hactive-12 under every timing, zxula_timing.vhd:423-424), so
// WAIT(line 50, X=4) + MOVE lands at paper pixel 32 (output half 64)
// under the 448-hcount 48K timing exactly as under the 456-hcount boot
// timing (the TestCopperMoveLandsOnHalfPixel pin).
func TestCopperInterleaveAnchorTimingIndependent(t *testing.T) {
	const wait50x4 = 0x8000 | 4<<9 | 50
	const move = 0x0155
	const halt = 0xFFFF
	u, _ := newHalfPixelCopperULA(t, []uint16{wait50x4, move, halt})
	u.mem.SetNextFrameGeometry(geo48K50Hz)
	u.Render()
	for hx, want := range map[int]byte{62: 0, 63: 0, 64: 1, 65: 1} {
		if _, g, _, _ := halfPaperPixel(u, hx, 50); g != want {
			t.Errorf("48K timing: half %d saw palette generation %d, want %d", hx, g, want)
		}
	}
}

// TestCopperWaitWrapFollowsLineLength pins the emergent WAIT wrap
// threshold: a WAIT with X=55 (release hcount (55<<3)+12 = 452) is
// reachable on a 456-hcount line (c_max_hc = 455, 128K/+3 timing) but
// can NEVER release on a 448-hcount line (c_max_hc = 447, 48K/Pentagon
// — the hcount wraps first, device/copper.vhd:94), so the following
// MOVE fires only under the long timing.
func TestCopperWaitWrapFollowsLineLength(t *testing.T) {
	const wait50x55 = 0x8000 | 55<<9 | 50
	const move = 0x0155
	const halt = 0xFFFF

	t.Run("456-hcount line releases X=55", func(t *testing.T) {
		u, _ := newHalfPixelCopperULA(t, []uint16{wait50x55, move, halt})
		u.Render() // boot geometry: 456 hcounts
		// Release at hcount 452 = end of line 50, past every paper
		// pixel: row 50 still renders generation 0, row 51 sees the
		// MOVE's write.
		if _, g, _, _ := halfPaperPixel(u, 300, 50); g != 0 {
			t.Errorf("row 50 saw generation %d, want 0 (release is past the paper)", g)
		}
		if _, g, _, _ := halfPaperPixel(u, 300, 51); g != 1 {
			t.Errorf("row 51 saw generation %d, want 1 (X=55 released at hcount 452)", g)
		}
	})

	t.Run("448-hcount line parks X=55 forever", func(t *testing.T) {
		u, _ := newHalfPixelCopperULA(t, []uint16{wait50x55, move, halt})
		u.mem.SetNextFrameGeometry(geo48K50Hz)
		u.Render()
		for _, y := range []int{50, 51, 100, 191} {
			if _, g, _, _ := halfPaperPixel(u, 300, y); g != 0 {
				t.Errorf("row %d saw generation %d, want 0 (threshold 452 > c_max_hc 447)", y, g)
			}
		}
	})
}

// TestBorderFoldFollowsPaperTop pins the raster-stamp row map: a
// border change stamped at raster line 50 folds onto the image row the
// live geometry puts at that raster line — row 42 under 60 Hz timing
// (paper top 40: image row r displays at raster r + 40 - 32) versus
// row 18 under the boot 50 Hz timing (paper top 64).
func TestBorderFoldFollowsPaperTop(t *testing.T) {
	stamp := func(u *ULA) {
		u.frameStartBorderColour = 1
		u.borderChanges = append(u.borderChanges[:0], borderChange{scanline: 50, colour: 2})
	}

	u, _, mem := newNextVideoULA(t)
	mem.SetNextFrameGeometry(geo128K60Hz)
	stamp(u)
	u.Render()
	if got := u.borderLineColours[41]; got != 1 {
		t.Errorf("60 Hz: image row 41 folded colour %d, want 1 (raster 49 precedes the stamp)", got)
	}
	if got := u.borderLineColours[42]; got != 2 {
		t.Errorf("60 Hz: image row 42 folded colour %d, want 2 (displays at raster 50)", got)
	}

	mem.SetNextFrameGeometry(memory.DefaultNextGeometry())
	stamp(u)
	u.Render()
	if got := u.borderLineColours[17]; got != 1 {
		t.Errorf("boot timing: image row 17 folded colour %d, want 1", got)
	}
	if got := u.borderLineColours[18]; got != 2 {
		t.Errorf("boot timing: image row 18 folded colour %d, want 2 (displays at raster 50)", got)
	}
}
