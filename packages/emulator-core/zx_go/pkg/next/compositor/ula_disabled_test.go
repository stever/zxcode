package compositor

// NR$68 bit 7 ("Disable ULA output") conformance in the priority
// ladders (#205). FPGA truth: zxnext.vhd:7103 —
//
//	ula_transparent <= '1' when (ula_mix_transparent = '1')
//	                         or (ula_en_2 = '0') else '0';
//
// — the whole ULA/LoRes slot is transparent in the mixer while the
// ULA output is disabled, so every lower layer shows through in EVERY
// NR$15 ordering. The ladders that re-paint the ULA above a lower
// layer (LUS/SUL/USL/ULS) must consume this signal: without it the
// opaque disabled-fill pixel painted over sprites and Layer 2.
// TX-1696's title menu (sprite-drawn, mode LUS, ULA disabled) rendered
// pure black exactly this way.

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/palette"
	"github.com/conorarmstrong/zx_go/pkg/next/sprite"
)

// ulaDisabledSpriteFixture: a red sprite covering paper x 0..15 on row
// 0, no Layer 2, no tilemap. The ULA scan passed to ComposeScanline is
// the opaque black disabled-fill the ULA's disabled path produces.
func ulaDisabledSpriteFixture(t *testing.T) *Compositor {
	t.Helper()
	pal := palette.NewBank()
	pal.Select(palette.PaletteSpritesFirst)
	pal.Active().Set(1, 0b1_1100_0000) // sprite ink = pure red
	pal.Select(0)

	sp := sprite.New()
	sp.SetEnabled(true)
	for i := 0; i < 128; i++ {
		sp.SetPatternAddr(uint16(i))
		sp.WritePatternByte(0x01)
	}
	// Frame (32,32) = paper top-left.
	sp.Set(0, sprite.Attr{X: 32, Y: 32, Pattern: 0, Visible: true})

	c := New(pal, nil)
	c.SetSprites(sp)
	return c
}

func composeDisabledFillRow(c *Compositor) []byte {
	// The ULA disabled path fills the frame with the opaque fallback
	// colour; the compose recovers exactly these pixels as the ULA scan.
	ula := make([]byte, Width*4)
	for x := 0; x < Width; x++ {
		ula[x*4+3] = 0xFF // opaque black
	}
	dst := make([]byte, Width*4)
	c.ComposeScanline(0, ula, dst)
	return dst
}

// TestULADisabledLUSShowsSprites pins the fix: with the ULA output
// disabled and priority L>U>S, the sprite must show — the ladder's
// ULA re-paint over the sprite is suppressed by the forced
// transparency (zxnext.vhd:7103).
func TestULADisabledLUSShowsSprites(t *testing.T) {
	c := ulaDisabledSpriteFixture(t)
	c.SetPriorityModeOverride(byte(ModeLUS))
	c.SetULAOutputDisabled(true)
	dst := composeDisabledFillRow(c)
	for x := 0; x < 16; x++ {
		r, g, b := dst[x*4+0], dst[x*4+1], dst[x*4+2]
		if r == 0 || g != 0 || b != 0 {
			t.Fatalf("x=%d under sprite (ULA disabled, LUS): rgb=%d/%d/%d, want pure red", x, r, g, b)
		}
	}
}

// TestULAEnabledLUSCoversSprites is the control: with the ULA output
// ENABLED, L>U>S puts the opaque ULA pixel above the sprite — the
// re-paint must keep happening.
func TestULAEnabledLUSCoversSprites(t *testing.T) {
	c := ulaDisabledSpriteFixture(t)
	c.SetPriorityModeOverride(byte(ModeLUS))
	dst := composeDisabledFillRow(c)
	for x := 0; x < 16; x++ {
		r, g, b := dst[x*4+0], dst[x*4+1], dst[x*4+2]
		if r != 0 || g != 0 || b != 0 {
			t.Fatalf("x=%d under sprite (ULA enabled, LUS): rgb=%d/%d/%d, want opaque black ULA", x, r, g, b)
		}
	}
}

// TestULADisabledUSLShowsSprites covers the U-on-top orderings' shared
// re-paint (USL exercises the same `if !ulaTrans` store as ULS/SUL).
func TestULADisabledUSLShowsSprites(t *testing.T) {
	c := ulaDisabledSpriteFixture(t)
	c.SetPriorityModeOverride(byte(ModeUSL))
	c.SetULAOutputDisabled(true)
	dst := composeDisabledFillRow(c)
	for x := 0; x < 16; x++ {
		r, g, b := dst[x*4+0], dst[x*4+1], dst[x*4+2]
		if r == 0 || g != 0 || b != 0 {
			t.Fatalf("x=%d under sprite (ULA disabled, USL): rgb=%d/%d/%d, want pure red", x, r, g, b)
		}
	}
}
