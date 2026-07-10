package compositor

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/layer2"
	"github.com/conorarmstrong/zx_go/pkg/next/palette"
)

// redOpaqueLayer2 builds an enabled 256x192 Layer 2 whose row content is
// all palette index 5, with entry 5 = pure red in the Layer 2 palette.
func redOpaqueLayer2(pal *palette.Bank) *layer2.Layer2 {
	pal.Select(palette.PaletteLayer2First)
	pal.Active().Set(5, 0b1_1100_0000)
	pal.Select(0)
	bank := make([]byte, 16384)
	for i := range bank {
		bank[i] = 5
	}
	// 5 banks: enough for the 320x256 column-major layout (81920 bytes),
	// of which the 256x192 row-major mode uses the first three.
	l2 := layer2.New(&fakeBanks{banks: map[int][]byte{
		0: bank, 1: bank, 2: bank, 3: bank, 4: bank,
	}})
	l2.SetActiveBank(0)
	l2.SetEnabled(true)
	return l2
}

// The Lone Wolf map screen (work item #92): Layer 2 clipped to Y1=8 must
// leave rows 0-7 to the ULA (the game's title bar) while row 8+ paints
// Layer 2. Before the fix NR$18 was stored but never applied, so Layer 2
// covered the title row.
func TestComposeScanlineLayer2ClipTopShowsULA(t *testing.T) {
	pal := palette.NewBank()
	l2 := redOpaqueLayer2(pal)
	l2.SetClip(0, 255, 8, 191)
	c := New(pal, l2)

	ulaRGBA := make([]byte, Width*4)
	for i := 0; i < Width; i++ {
		ulaRGBA[i*4+1] = 0xAA // green-ish ULA row
		ulaRGBA[i*4+3] = 0xFF
	}
	dst := make([]byte, Width*4)

	c.ComposeScanline(7, ulaRGBA, dst)
	for i, b := range dst {
		if b != ulaRGBA[i] {
			t.Fatalf("clipped row 7: dst[%d]=%#x, want ULA %#x", i, b, ulaRGBA[i])
		}
	}

	c.ComposeScanline(8, ulaRGBA, dst)
	if r, g := dst[0], dst[1]; r == 0 || g != 0 {
		t.Fatalf("visible row 8: got r=%d g=%d, want red Layer 2 pixel", r, g)
	}
}

func TestComposeScanlineLayer2ClipXWindow(t *testing.T) {
	pal := palette.NewBank()
	l2 := redOpaqueLayer2(pal)
	l2.SetClip(16, 47, 0, 191)
	c := New(pal, l2)

	ulaRGBA := make([]byte, Width*4)
	dst := make([]byte, Width*4)
	c.ComposeScanline(0, ulaRGBA, dst)

	if dst[15*4] != 0 {
		t.Fatal("x=15 painted, want clipped (X1=16)")
	}
	if dst[16*4] == 0 {
		t.Fatal("x=16 not painted, want Layer 2 red")
	}
	if dst[47*4] == 0 {
		t.Fatal("x=47 not painted, want Layer 2 red")
	}
	if dst[48*4] != 0 {
		t.Fatal("x=48 painted, want clipped (X2=47)")
	}
}

func TestComposeWideLayer2RowHonoursClip(t *testing.T) {
	pal := palette.NewBank()
	l2 := redOpaqueLayer2(pal)
	l2.SetResolution(1)        // 320x256
	l2.SetClip(10, 100, 0, 255) // X doubled in wide mode -> [20, 201]
	c := New(pal, l2)

	dst := make([]byte, 320*4)
	c.ComposeWideLayer2Row(0, dst)
	if dst[19*4] != 0 {
		t.Fatal("wide x=19 painted, want clipped (X1*2=20)")
	}
	if dst[20*4] == 0 {
		t.Fatal("wide x=20 not painted, want Layer 2 red")
	}
	if dst[201*4] == 0 {
		t.Fatal("wide x=201 not painted, want Layer 2 red")
	}
	if dst[202*4] != 0 {
		t.Fatal("wide x=202 painted, want clipped (X2*2+1=201)")
	}

	// Fully-clipped row (default-style Y window moved off this row).
	l2.SetClip(10, 100, 50, 255)
	for i := range dst {
		dst[i] = 0
	}
	c.ComposeWideLayer2Row(0, dst)
	for i, b := range dst {
		if b != 0 {
			t.Fatalf("row 0 painted at byte %d despite Y1=50", i)
		}
	}
}
