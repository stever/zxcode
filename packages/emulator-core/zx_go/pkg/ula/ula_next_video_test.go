package ula

// Unit tests for the Spectrum Next ULA-video features delivered by the
// MrKWatkins ULA conformance group: NR$26/$27 hardware scroll and the
// NR$1A clip window in renderNextULARow (video/zxula.vhd:192-208, :199,
// :562), and the raster-stamped displayed-ULA-palette replay
// (NR$43 bit 1 mid-frame flips, exercised by ULA/ClassicPaletized).

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// liveULAMock is a NextCompositor that satisfies nextULAPaletteResolver
// (+ selector), resolving every palette index to a colour that encodes
// (activePalette, idx) so assertions can decode exactly which entry a
// pixel went through. ComposeScanline is a pass-through copy.
type liveULAMock struct {
	second      bool
	selectCalls []bool
}

func (m *liveULAMock) ComposeScanline(y int, ula, dst []byte)                     { copy(dst, ula) }
func (m *liveULAMock) HasActiveTilemap() bool                                     { return false }
func (m *liveULAMock) ComposeBorderRow(y int, dst []byte, f func(int) bool)       {}
func (m *liveULAMock) HasActiveSprites() bool                                     { return false }
func (m *liveULAMock) ComposeSpriteBorderRow(y int, dst []byte, f func(int) bool) {}
func (m *liveULAMock) TilemapIs80Col() bool                                       { return false }
func (m *liveULAMock) ComposeWideTilemapRow(y int, dst []byte)                    {}
func (m *liveULAMock) HiResLayer2Active() bool                                    { return false }
func (m *liveULAMock) Layer2Width() int                                           { return 320 }
func (m *liveULAMock) ComposeWideLayer2Row(y int, dst []byte)                     {}
func (m *liveULAMock) FallbackRGBA() [4]byte                                      { return [4]byte{9, 8, 7, 0xFF} }

// ULARGBA encodes the resolution: R = idx, G = 1 for the second palette
// (0 for the first), B = 0xAB marker. Never transparent.
func (m *liveULAMock) ULARGBA(idx byte) (byte, byte, byte, bool) {
	g := byte(0)
	if m.second {
		g = 1
	}
	return idx, g, 0xAB, false
}

func (m *liveULAMock) SetULAActivePalette(second bool) {
	m.second = second
	m.selectCalls = append(m.selectCalls, second)
}

func newNextVideoULA(t *testing.T) (*ULA, *liveULAMock, *memory.Memory) {
	t.Helper()
	dir := t.TempDir()
	createTestROMs(t, dir)
	mem, err := memory.New(dir, roms.Model48K)
	if err != nil {
		t.Fatalf("memory.New: %v", err)
	}
	u := New(mem, keyboard.New())
	m := &liveULAMock{}
	u.SetNextCompositor(m)
	return u, m, mem
}

// paperPixel reads the rendered image pixel for paper coordinate (x, y).
func paperPixel(u *ULA, x, y int) (r, g, b, a byte) {
	img := u.img
	off := (BorderTop+y)*img.Stride + (BorderLeft+x)*4
	return img.Pix[off], img.Pix[off+1], img.Pix[off+2], img.Pix[off+3]
}

// TestNextULARowHardwareScroll pins the NR$26/$27 scroll source mapping:
// display pixel (x, y) fetches pixels AND attributes from source
// ((x+NR$26) mod 256, (y+NR$27) mod 192) — video/zxula.vhd:199 (px char
// column + scroll, neighbour char mod 32) and :192/:201-208 (py folded
// mod 192).
func TestNextULARowHardwareScroll(t *testing.T) {
	u, _, mem := newNextVideoULA(t)
	page := mem.GetPage(mem.ScreenPage)

	// Source cell: char col 3, pixel row 100 (char row 12). One set pixel
	// at source x = 3*8+2 = 26, y = 100. Attr of that cell = $17
	// (paper 2, ink 7): ink pixel resolves to idx 7, paper to 16+2.
	page[screenAddrForRowCol(100, 3)] = 0x20 // bit 2 of the char
	page[0x1800+(100>>3)*32+3] = 0x17

	// Scroll so display (6, 88) lands on source (26, 100):
	// x: 6 + 20 = 26; y: 88 + 12 = 100.
	u.SetULAScroll(20, 12)
	u.Render()

	if r, g, _, a := paperPixel(u, 6, 88); r != 7 || g != 0 || a != 0xFF {
		t.Errorf("scrolled ink pixel = idx %d (g=%d a=%d), want idx 7 via first palette", r, g, a)
	}
	// Neighbouring pixel in the same source cell is paper: idx 16+2.
	if r, _, _, _ := paperPixel(u, 7, 88); r != 18 {
		t.Errorf("scrolled paper pixel = idx %d, want 18 (16+paper 2)", r)
	}

	// X wrap: display x 250 + scroll 20 = 270 mod 256 = source x 14
	// (char col 1). Y wrap: display y 100 + scroll 180 = 280 mod 192 =
	// source y 88 (char row 11).
	page[screenAddrForRowCol(88, 1)] = 0x02 // bit 6 of the char → src x 14
	page[0x1800+(88>>3)*32+1] = 0x35        // paper 6, ink 5
	u.SetULAScroll(20, 180)
	u.Render()
	if r, _, _, _ := paperPixel(u, 250, 100); r != 5 {
		t.Errorf("wrapped ink pixel = idx %d, want 5 (ink of source cell)", r)
	}
}

// TestNextULARowClipWindow pins the NR$1A clip: paper pixels outside the
// inclusive [x1,x2]×[y1,y2] display-space window are transparent (alpha
// 0, fallback RGB) regardless of scroll; inside pixels are untouched
// (zxula.vhd:562).
func TestNextULARowClipWindow(t *testing.T) {
	u, m, _ := newNextVideoULA(t)
	u.SetULAClipWindow(8, 239, 8, 175)
	u.Render()

	fb := m.FallbackRGBA()
	for _, p := range []struct {
		x, y    int
		clipped bool
	}{
		{7, 100, true}, {8, 100, false}, {239, 100, false}, {240, 100, true},
		{100, 7, true}, {100, 8, false}, {100, 175, false}, {100, 176, true},
		{0, 0, true}, {255, 191, true},
	} {
		r, g, b, a := paperPixel(u, p.x, p.y)
		if p.clipped {
			if a != 0 || r != fb[0] || g != fb[1] || b != fb[2] {
				t.Errorf("(%d,%d): got rgba(%d,%d,%d,%d), want transparent fallback", p.x, p.y, r, g, b, a)
			}
		} else if a != 0xFF {
			t.Errorf("(%d,%d): alpha %d, want opaque (inside clip)", p.x, p.y, a)
		}
	}
}

// TestULAPaletteSelectMidFrameReplay pins the raster-stamped NR$43 bit 1
// replay: a mid-frame flip to the second ULA palette renders rows before
// the flip's raster line through the first palette and rows after
// through the second — and restores the live selection afterwards. This
// is the ULA/ClassicPaletized behaviour (top half default palette,
// bottom half custom).
func TestULAPaletteSelectMidFrameReplay(t *testing.T) {
	u, m, mem := newNextVideoULA(t)
	tstates := uint64(0)
	mem.TStates = &tstates
	refT := uint64(1000)
	mem.RefTstates = func() uint64 { return refT }

	// Frame-start state: first palette (live default). Flip to the second
	// at frame scanline 150: display line 110 = paper row 86.
	tstates = uint64(150 * TStatesPerLineFor(mem.GetCurrentModel()))
	u.SetULAPaletteSecond(true)

	u.Render()

	if _, g, _, _ := paperPixel(u, 128, 50); g != 0 {
		t.Errorf("row 50 resolved through palette %d, want first (before mid-frame flip)", g)
	}
	if _, g, _, _ := paperPixel(u, 128, 120); g != 1 {
		t.Errorf("row 120 resolved through palette %d, want second (after mid-frame flip)", g)
	}
	if !m.second {
		t.Errorf("live selection not restored to second after the replay walk")
	}

	// A back-to-back Render with NO execution (the harness screenshot
	// path — reference clock unchanged) must keep the split maps instead
	// of rebuilding uniform live state.
	u.Render()
	if _, g, _, _ := paperPixel(u, 128, 50); g != 0 {
		t.Errorf("stale re-render lost the raster-stamped palette split")
	}

	// After an executed frame with no changes (clock advanced), the map
	// collapses to the live state — second palette everywhere.
	refT += 70908
	u.Render()
	if _, g, _, _ := paperPixel(u, 128, 50); g != 1 {
		t.Errorf("post-flip frame: row 50 through palette %d, want second (live)", g)
	}
}
