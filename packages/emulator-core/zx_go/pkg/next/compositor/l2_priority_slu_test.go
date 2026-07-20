package compositor

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/palette"
	"github.com/conorarmstrong/zx_go/pkg/next/sprite"
)

// greenSpriteAtPaperOrigin builds an enabled sprite engine with sprite 0
// as a 16x16 block of sprite-palette index 1 (green) at the paper's
// top-left (frame 32,32).
func greenSpriteAtPaperOrigin(pal *palette.Bank) *sprite.Engine {
	pal.Select(palette.PaletteSpritesFirst)
	pal.Active().Set(1, 0b0_0011_1000) // green
	pal.Select(0)
	sp := sprite.New()
	sp.SetEnabled(true)
	for i := 0; i < 256; i++ {
		sp.SetPatternAddr(uint16(i))
		sp.WritePatternByte(0x01) // 8bpp: byte == palette index 1
	}
	sp.Set(0, sprite.Attr{X: 32, Y: 32, Pattern: 0, Visible: true})
	return sp
}

// TestPriorityModeSLULayer2PriorityOverSprite verifies the per-pixel
// Layer 2 priority bit (NR$44 bit 7) promotes an L2 pixel above the
// sprites in the default SLU mode — the mixer's SLU ladder tests
// layer2Priority before the sprite. Head Over Heels for Next draws its
// isometric foreground (door frames) with priority-flagged colours so
// they cover the player sprite (#195); without the promotion the sprite
// wrongly painted on top.
func TestPriorityModeSLULayer2PriorityOverSprite(t *testing.T) {
	pal := palette.NewBank()
	l2 := redOpaqueLayer2(pal)
	pal.Select(palette.PaletteLayer2First)
	pal.Active().SetPriority(5, 0x02) // L2 promote bit (NR$44 bit 7)
	pal.Select(0)
	sp := greenSpriteAtPaperOrigin(pal)

	c := New(pal, l2)
	c.SetSprites(sp)
	c.SetPrioritySource(fakedPrio{ModeSLU})

	ulaRGBA := make([]byte, Width*4)
	dst := make([]byte, Width*4)
	c.ComposeScanline(0, ulaRGBA, dst)

	// Pixels 0..15 under the sprite: the priority bit promotes L2 red.
	for x := 0; x < 16; x++ {
		r, g, b := dst[x*4+0], dst[x*4+1], dst[x*4+2]
		if r == 0 || g != 0 || b != 0 {
			t.Errorf("SLU x=%d: rgb=%d/%d/%d, want red (priority L2 above sprite)", x, r, g, b)
			break
		}
	}
}

// TestPriorityModeSLUSpriteOverPlainLayer2 pins the counterpart: without
// the priority bit the SLU order is unchanged — the sprite stays above
// Layer 2.
func TestPriorityModeSLUSpriteOverPlainLayer2(t *testing.T) {
	pal := palette.NewBank()
	l2 := redOpaqueLayer2(pal)
	sp := greenSpriteAtPaperOrigin(pal)

	c := New(pal, l2)
	c.SetSprites(sp)
	c.SetPrioritySource(fakedPrio{ModeSLU})

	ulaRGBA := make([]byte, Width*4)
	dst := make([]byte, Width*4)
	c.ComposeScanline(0, ulaRGBA, dst)

	for x := 0; x < 16; x++ {
		r, g, b := dst[x*4+0], dst[x*4+1], dst[x*4+2]
		if r != 0 || g == 0 || b != 0 {
			t.Errorf("SLU x=%d: rgb=%d/%d/%d, want green (sprite above plain L2)", x, r, g, b)
			break
		}
	}
}

// TestOverpaintWideL2RowLayer2Priority verifies the wide (hi-res 320x256)
// path's counterpart: after OverpaintWideL2Row repaints the sprites over
// the hi-res Layer 2 overlay, priority-bit L2 pixels are repainted on
// top — the same #195 promotion in the mode Head Over Heels actually
// runs in.
func TestOverpaintWideL2RowLayer2Priority(t *testing.T) {
	pal := palette.NewBank()
	l2 := redOpaqueLayer2(pal)
	l2.SetResolution(1) // 320x256
	pal.Select(palette.PaletteLayer2First)
	pal.Active().SetPriority(5, 0x02)
	pal.Select(0)
	sp := greenSpriteAtPaperOrigin(pal)

	c := New(pal, l2)
	c.SetSprites(sp)
	c.SetPrioritySource(fakedPrio{ModeSLU})

	// Frame row 32 = the sprite's first row. xScale 2: 640 output px.
	row := make([]byte, FullWidth*2*4)
	c.ComposeWideLayer2Row(32, row, 2)
	c.OverpaintWideL2Row(32, row, 2)

	// Frame x 32..47 (output px 64..95) sit under the sprite; the
	// priority bit keeps L2 red on top.
	for x := 64; x < 96; x++ {
		r, g, b := row[x*4+0], row[x*4+1], row[x*4+2]
		if r == 0 || g != 0 || b != 0 {
			t.Errorf("wide x=%d: rgb=%d/%d/%d, want red (priority L2 above sprite)", x, r, g, b)
			break
		}
	}
}

// TestOverpaintWideL2RowPlainKeepsSprite pins the wide-path counterpart:
// without the priority bit the sprite overpaint stays on top.
func TestOverpaintWideL2RowPlainKeepsSprite(t *testing.T) {
	pal := palette.NewBank()
	l2 := redOpaqueLayer2(pal)
	l2.SetResolution(1)
	sp := greenSpriteAtPaperOrigin(pal)

	c := New(pal, l2)
	c.SetSprites(sp)
	c.SetPrioritySource(fakedPrio{ModeSLU})

	row := make([]byte, FullWidth*2*4)
	c.ComposeWideLayer2Row(32, row, 2)
	c.OverpaintWideL2Row(32, row, 2)

	for x := 64; x < 96; x++ {
		r, g, b := row[x*4+0], row[x*4+1], row[x*4+2]
		if r != 0 || g == 0 || b != 0 {
			t.Errorf("wide x=%d: rgb=%d/%d/%d, want green (sprite above plain L2)", x, r, g, b)
			break
		}
	}
}
