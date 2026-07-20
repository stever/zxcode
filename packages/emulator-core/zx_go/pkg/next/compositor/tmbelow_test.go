package compositor

// Per-pixel tm_below conformance (#154). FPGA truth:
//
//   - tilemap.vhd:388: each pixel's below bit =
//     (attr_bit0 OR mode_512) AND NOT tm_on_top — PER TILE via
//     attribute bit 0 ("ULA over tilemap"), 512-mode forces below,
//     NR$6B bit 0 forces on-top.
//   - zxnext.vhd:7116: ulatm_rgb <= tm_rgb when tm opaque AND
//     (below = 0 OR ula_transparent) else ula_rgb — a below pixel
//     yields to an OPAQUE ULA pixel only.
//
// The old model approximated below with the GLOBAL on_top bit plus a
// "nibble-0 is transparent" rule — inverted for attr0=0 tiles with
// on_top off (the FPGA default puts those ABOVE the ULA).

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/palette"
	"github.com/conorarmstrong/zx_go/pkg/next/tilemap"
)

// tmBelowFixture builds a compositor + tilemap where paper columns
// 0-7 come from a tile with attr bit 0 SET (below) and columns 8-15
// from the same tile with attr bit 0 CLEAR (above). The tile paints
// palette nibble 5 everywhere; tilemap palette entry 5 is green.
func tmBelowFixture(t *testing.T, control byte) *Compositor {
	t.Helper()
	br := &fakeBankReader{}
	bank := make([]byte, 16384)
	// Tile 1's 4bpp definition at tiles base 0: 32 bytes of nibble 5.
	for i := 32; i < 64; i++ {
		bank[i] = 0x55
	}
	// Paper row 0 = frame row 32 → tile row 4. 40 tiles × 2 bytes per
	// row = 80 bytes; paper column 0 starts at frame column 32 =
	// tile cell 4.
	row4 := 4 * 80
	bank[row4+4*2] = 0x01   // cell 4: tile 1
	bank[row4+4*2+1] = 0x01 // attr bit 0 = ULA over tilemap (below)
	bank[row4+5*2] = 0x01   // cell 5: tile 1
	bank[row4+5*2+1] = 0x00 // attr bit 0 clear (tilemap over ULA)
	br.banks[5] = bank

	tm := tilemap.New(br)
	tm.SetEnabled(true)
	tm.SetTileMapBase(0x00)
	tm.SetTilesBase(0x00)
	tm.SetControl(control)

	pal := palette.NewBank()
	pal.Select(palette.PaletteTilemapFirst)
	pal.Active().Set(0x05, 0b0_0011_1000) // tilemap ink = green
	pal.Select(0)

	c := New(pal, nil)
	c.SetTilemap(tm)
	if !c.HasActiveTilemap() {
		t.Fatal("tilemap not active after wiring")
	}
	return c
}

// composeTMRow runs ComposeScanline for paper row 0 with a synthetic
// ULA row: opaque white pixels except column x where ulaTransparentX
// makes the pixel transparent (alpha 0 — the live render's per-pixel
// signal). Returns dst.
func composeTMRow(c *Compositor, transparentX int) []byte {
	ula := make([]byte, Width*4)
	for x := 0; x < Width; x++ {
		off := x * 4
		ula[off+0], ula[off+1], ula[off+2], ula[off+3] = 0xFF, 0xFF, 0xFF, 0xFF
		if x == transparentX {
			ula[off+3] = 0
		}
	}
	dst := make([]byte, Width*4)
	c.ComposeScanline(0, ula, dst)
	return dst
}

func isGreen(dst []byte, x int) bool {
	off := x * 4
	return dst[off+0] == 0 && dst[off+1] != 0 && dst[off+2] == 0
}

func isWhite(dst []byte, x int) bool {
	off := x * 4
	return dst[off+0] == 0xFF && dst[off+1] == 0xFF && dst[off+2] == 0xFF
}

// TestTMBelowPerTileAttrBit pins the per-tile arbitration with
// tm_on_top OFF: the attr0=1 tile yields to opaque ULA and paints
// over transparent ULA; the attr0=0 tile covers the ULA.
func TestTMBelowPerTileAttrBit(t *testing.T) {
	c := tmBelowFixture(t, 0x00) // attrs present, on_top off
	dst := composeTMRow(c, 2)    // ULA transparent at paper x=2 (below tile)

	if !isWhite(dst, 0) {
		t.Errorf("below tile over OPAQUE ULA: pixel 0 not ULA white (vhd:7116)")
	}
	if !isGreen(dst, 2) {
		t.Errorf("below tile over TRANSPARENT ULA: pixel 2 not tilemap green (vhd:7116)")
	}
	if !isGreen(dst, 8) {
		t.Errorf("attr0=0 tile must cover the ULA: pixel 8 not tilemap green (vhd:388)")
	}
}

// TestTMBelowOnTopOverrides: NR$6B bit 0 forces every pixel on top —
// the below tile now covers opaque ULA too.
func TestTMBelowOnTopOverrides(t *testing.T) {
	c := tmBelowFixture(t, 0x01) // on_top
	dst := composeTMRow(c, -1)
	if !isGreen(dst, 0) || !isGreen(dst, 8) {
		t.Errorf("on_top set: both tiles must cover the ULA (vhd:388 not tm_on_top term)")
	}
}

// TestTMBelow512ModeForcesBelow: in 512-tile mode the attr bit is the
// tile-index MSB and every pixel is below (with on_top off). Probes
// use cell 5 (attr $00 → still tile 1 in 512 mode); cell 4's attr $01
// now addresses tile 257 (empty) instead of carrying a below flag.
func TestTMBelow512ModeForcesBelow(t *testing.T) {
	c := tmBelowFixture(t, 0x02) // mode_512, on_top off
	dst := composeTMRow(c, 10)   // ULA transparent inside cell 5
	if !isWhite(dst, 8) {
		t.Errorf("512 mode: attr0=0 tile must be BELOW opaque ULA (vhd:388 mode_512 term)")
	}
	if !isGreen(dst, 10) {
		t.Errorf("512 mode: below tile over transparent ULA must paint")
	}
}

// TestTMBelowWideOverlayULADisabled pins the WIDE-path tilemap overlay's
// below-tile arbitration against a DISABLED ULA (#196, Atic Atac's story
// scene and closed-door tiles). FPGA truth: NR$68 bit 7 makes every ULA
// pixel transparent (ula_transparent <= ... or ula_en_2 = '0',
// zxnext.vhd:7102), and the ulatm mux shows a below tile over a
// transparent ULA (tm_pixel_below_2 = '0' OR ula_transparent = '1',
// zxnext.vhd:7116). The overlay cannot see per-pixel ULA data, but with
// the ULA disabled there is none to consult: below tiles must paint.
// With the ULA enabled the overlay keeps the documented conservative
// skip (it would need the per-pixel ULA data).
func TestTMBelowWideOverlayULADisabled(t *testing.T) {
	// Fixture frame row 32 holds the below tile at tile cell 4 (frame
	// x 32-39) and the above tile at cell 5 (frame x 40-47).
	const belowX, aboveX = 32, 40

	overlayRow := func(disabled bool) []byte {
		c := tmBelowFixture(t, 0x00)
		c.SetULAOutputDisabled(disabled)
		dst := make([]byte, FullWidth*4)
		c.composeTilemapOverlayRow(32, dst, 1)
		return dst
	}

	dst := overlayRow(true)
	if !isGreen(dst, belowX) {
		t.Errorf("ULA disabled: below tile must paint in the wide overlay (vhd:7102/7116)")
	}
	if !isGreen(dst, aboveX) {
		t.Errorf("ULA disabled: above tile must paint in the wide overlay")
	}

	dst = overlayRow(false)
	if isGreen(dst, belowX) {
		t.Errorf("ULA enabled: below tile must keep the conservative skip in the wide overlay")
	}
	if !isGreen(dst, aboveX) {
		t.Errorf("ULA enabled: above tile must paint in the wide overlay")
	}
}
