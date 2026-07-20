package compositor

// Classic ULA pixels above wide (hi-res) Layer 2 in the U-above-L
// NR$15 modes (#204). FPGA truth: the priority chain places the
// combined ULA+TM slot above Layer 2 in SUL/USL/ULS (zxnext.vhd
// mixer ladders, :7100-7355), with the ULA pixel transparent when its
// colour projects to NR$14 (zxnext.vhd:7103 ula_mix_transparent).
// The wide-L2 render path covers the whole base frame with the Layer 2
// overlay, so OverpaintWideL2Row must repaint the ULA's non-transparent
// pixels from the CaptureULABase snapshot. Space Invaders runs USL
// with NR$14=black over a 320x256 planet backdrop: its white arcade
// overlay (score header, invaders, CREDIT) was invisible before this,
// leaving the game apparently stuck on its "initial screen".

import (
	"image/color"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/palette"
)

// ulaAboveWideL2Fixture: hi-res (320x256) opaque red Layer 2, USL
// priority, classic ULA palette with NR$14=0 (black transparent), and
// a captured pure-ULA base frame that is black everywhere except a
// white run at output pixels 100..109 of row 40.
func ulaAboveWideL2Fixture(t *testing.T, mode PriorityMode) (*Compositor, int, int) {
	t.Helper()
	pal := palette.NewBank()
	l2 := redOpaqueLayer2(pal)
	l2.SetResolution(1) // 320x256

	c := New(pal, l2)
	c.SetPrioritySource(fakedPrio{mode})

	var ulaPal [16]color.RGBA
	ulaPal[0] = color.RGBA{0, 0, 0, 255} // classic black
	ulaPal[7] = color.RGBA{255, 255, 255, 255}
	c.SetULAPalette(ulaPal)
	c.SetTransparency(0) // NR$14 = black

	const w, h = FullWidth * 2, 256
	base := make([]byte, w*h*4)
	for i := 3; i < len(base); i += 4 {
		base[i] = 0xFF // opaque black frame
	}
	row := 40
	for x := 100; x < 110; x++ {
		o := (row*w + x) * 4
		base[o+0], base[o+1], base[o+2] = 0xFF, 0xFF, 0xFF
	}
	c.CaptureULABase(base, w*4, w, h)
	return c, w, row
}

// TestULAAboveWideL2USL pins the fix: in USL the white ULA pixels
// repaint above the wide Layer 2 overlay while the black (NR$14
// transparent) pixels leave Layer 2 visible.
func TestULAAboveWideL2USL(t *testing.T) {
	c, w, row := ulaAboveWideL2Fixture(t, ModeUSL)

	dst := make([]byte, w*4)
	c.ComposeWideLayer2Row(row, dst, 2)
	c.OverpaintWideL2Row(row, dst, 2)

	for x := 100; x < 110; x++ {
		r, g, b := dst[x*4+0], dst[x*4+1], dst[x*4+2]
		if r != 0xFF || g != 0xFF || b != 0xFF {
			t.Fatalf("USL x=%d: rgb=%d/%d/%d, want white ULA above wide L2", x, r, g, b)
		}
	}
	// A black (transparent) ULA pixel keeps the red Layer 2.
	r, g, b := dst[50*4+0], dst[50*4+1], dst[50*4+2]
	if r == 0 || g != 0 || b != 0 {
		t.Fatalf("USL x=50: rgb=%d/%d/%d, want red L2 under transparent ULA", r, g, b)
	}
}

// TestULAAboveWideL2SLUUnchanged pins the counterpart: in SLU (L above
// U is false but U is the BOTTOM layer) the capture is invalidated and
// nothing repaints — wide Layer 2 stays on top of the ULA.
func TestULAAboveWideL2SLUUnchanged(t *testing.T) {
	c, w, row := ulaAboveWideL2Fixture(t, ModeSLU)

	dst := make([]byte, w*4)
	c.ComposeWideLayer2Row(row, dst, 2)
	c.OverpaintWideL2Row(row, dst, 2)

	for x := 100; x < 110; x++ {
		r, g, b := dst[x*4+0], dst[x*4+1], dst[x*4+2]
		if !(r != 0 && g == 0 && b == 0) {
			t.Fatalf("SLU x=%d: rgb=%d/%d/%d, want red L2 covering the ULA", x, r, g, b)
		}
	}
}

// TestULAAboveWideL2DisabledULA pins the NR$68-bit-7 gate: with the ULA
// output disabled the capture invalidates and the U slot stays fully
// transparent (the RAMS class — USL with the ULA disabled).
func TestULAAboveWideL2DisabledULA(t *testing.T) {
	c, w, row := ulaAboveWideL2Fixture(t, ModeUSL)
	c.SetULAOutputDisabled(true)

	const h = 256
	base := make([]byte, w*h*4)
	for i := 0; i < len(base); i += 4 {
		base[i], base[i+3] = 0xFF, 0xFF // opaque red-ish fill everywhere
	}
	c.CaptureULABase(base, w*4, w, h)

	dst := make([]byte, w*4)
	c.ComposeWideLayer2Row(row, dst, 2)
	c.OverpaintWideL2Row(row, dst, 2)

	for x := 100; x < 110; x++ {
		r, g, b := dst[x*4+0], dst[x*4+1], dst[x*4+2]
		if !(r != 0 && g == 0 && b == 0) {
			t.Fatalf("disabled-ULA x=%d: rgb=%d/%d/%d, want red L2 (no ULA repaint)", x, r, g, b)
		}
	}
}
