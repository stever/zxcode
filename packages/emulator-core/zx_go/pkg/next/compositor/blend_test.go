package compositor

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/layer2"
	"github.com/conorarmstrong/zx_go/pkg/next/palette"
)

// TestComposeScanlineAdditiveBlend pins the NR$15 modes 6/7 additive
// blend through ComposeScanline: the scanline painter must produce the
// same clamped L+U (mode 6) / L+U-5 (mode 7) arithmetic as the
// FPGA-golden Mix (zxnext.vhd:7196-7355), replacing the old SLU
// approximation. Exercised externally by the MrKWatkins
// LightenDarken_L2_ULA test's gradient strips.
func TestComposeScanlineAdditiveBlend(t *testing.T) {
	pal := palette.NewBank()
	pal.Select(palette.PaletteLayer2First)
	pal.Active().Set(1, 0b101_000_000) // L2 red 5
	pal.Active().Set(2, 0b111_111_111) // L2 white 7,7,7
	pal.Active().Set(7, uint16(0xE3)<<1|1)
	pal.Select(0)

	bank := make([]byte, 16384)
	bank[0] = 1 // red 5 + ULA → blends
	bank[1] = 2 // white 7 → clamps at 7
	bank[2] = 7 // transparent L2
	l2 := layer2.New(&fakeBanks{banks: map[int][]byte{0: bank}})
	l2.SetActiveBank(0)
	l2.SetEnabled(true)

	c := New(pal, l2)
	prio := &fixedPriority{PriorityMode(6)}
	c.SetPrioritySource(prio)

	// ULA row: every pixel the 9-bit (3,3,3) mid grey — proj3to8(3) each.
	g := proj3to8(3)
	ulaRGBA := make([]byte, Width*4)
	for x := 0; x < Width; x++ {
		ulaRGBA[x*4+0], ulaRGBA[x*4+1], ulaRGBA[x*4+2], ulaRGBA[x*4+3] = g, g, g, 0xFF
	}
	dst := make([]byte, Width*4)
	c.ComposeScanline(0, ulaRGBA, dst)

	// Pixel 0: L2 (5,0,0) + ULA (3,3,3) = (8→7 clamp, 3, 3).
	want := [3]byte{proj3to8(7), proj3to8(3), proj3to8(3)}
	if dst[0] != want[0] || dst[1] != want[1] || dst[2] != want[2] {
		t.Errorf("mode 6 blend pixel 0 = %d,%d,%d, want %d,%d,%d",
			dst[0], dst[1], dst[2], want[0], want[1], want[2])
	}
	// Pixel 1: (7,7,7)+(3,3,3) clamps to (7,7,7).
	if dst[4] != proj3to8(7) || dst[5] != proj3to8(7) || dst[6] != proj3to8(7) {
		t.Errorf("mode 6 clamp pixel 1 = %d,%d,%d, want white", dst[4], dst[5], dst[6])
	}
	// Pixel 2: transparent L2 → the NR$4A fallback, NOT the ULA. The
	// upstream LightenDarken table confirms: `sTlTuu → TT` — in the
	// blend modes the ULA never shows alone; it only participates as
	// the additive operand of an opaque Layer 2 pixel. Default NR$4A
	// $E3 widens to (255,0,255) (low blue bit = OR of the pair).
	if dst[8] != 255 || dst[9] != 0 || dst[10] != 255 {
		t.Errorf("mode 6 transparent-L2 pixel 2 = %d,%d,%d, want fallback 255,0,255", dst[8], dst[9], dst[10])
	}

	// Mode 7: per-channel clamped L+U-5. Pixel 0: (5+3-5, 0+3-5, 0+3-5)
	// = (3, 0-clamped, 0-clamped).
	prio.m = PriorityMode(7)
	c.ComposeScanline(0, ulaRGBA, dst)
	if dst[0] != proj3to8(3) || dst[1] != 0 || dst[2] != 0 {
		t.Errorf("mode 7 blend pixel 0 = %d,%d,%d, want %d,0,0",
			dst[0], dst[1], dst[2], proj3to8(3))
	}
}
