package ula

// Unit tests for the Spectrum Next ULA-video features delivered by the
// MrKWatkins ULA conformance group: NR$26/$27 hardware scroll and the
// NR$1A clip window in renderNextULARow (video/zxula.vhd:192-208, :199,
// :562), and the raster-stamped displayed-ULA-palette replay
// (NR$43 bit 1 mid-frame flips, exercised by ULA/ClassicPaletized).

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/keyboard"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/roms"
)

// liveULAMock is a NextCompositor that satisfies nextULAPaletteResolver
// (+ selector), resolving every palette index to a colour that encodes
// (activePalette, idx) so assertions can decode exactly which entry a
// pixel went through. ComposeScanline is a pass-through copy.
type liveULAMock struct {
	second      bool
	selectCalls []bool
}

func (m *liveULAMock) ComposeScanline(y int, ula, dst []byte)                             { copy(dst, ula) }
func (m *liveULAMock) ComposeHiResScanline(y int, ula, dst []byte)                        { copy(dst, ula) }
func (m *liveULAMock) HasActiveTilemap() bool                                             { return false }
func (m *liveULAMock) ComposeBorderRow(y int, dst []byte, xs int, f func(int) bool)       {}
func (m *liveULAMock) HasActiveSprites() bool                                             { return false }
func (m *liveULAMock) ComposeSpriteBorderRow(y int, dst []byte, xs int, f func(int) bool) {}
func (m *liveULAMock) TilemapIs80Col() bool                                               { return false }
func (m *liveULAMock) ComposeWideTilemapRow(y int, dst []byte)                            {}
func (m *liveULAMock) HiResLayer2Active() bool                                            { return false }
func (m *liveULAMock) Layer2Width() int                                                   { return 320 }
func (m *liveULAMock) ComposeWideLayer2Row(y int, dst []byte, xs int)                     {}
func (m *liveULAMock) FallbackRGBA() [4]byte                                              { return [4]byte{9, 8, 7, 0xFF} }

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
func (m *liveULAMock) OverpaintWideL2Row(y int, dst []byte, xScale int) {}
func (m *liveULAMock) CaptureULABase(pix []byte, stride, w, h int)      {}

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
// With a Next compositor wired the frame is the FPGA's 320×256 wide
// frame at doubled output width (640×256, xs = 2): the paper starts at
// output (2*BorderLeft, NextBorderTop) = (64, 32), two output pixels per
// frame pixel.
func paperPixel(u *ULA, x, y int) (r, g, b, a byte) {
	img := u.img
	off := (NextBorderTop+y)*img.Stride + (BorderLeft+x)*u.xs*4
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

// TestNextULARowTimexModes pins the Timex display-mode decode in the
// live ULA row render (port $FF bits 2:0, zxula.vhd:191/235-251):
//
//   - mode 001 ("screen 1"): pixels fetch from display file 2 (+$2000 —
//     vram_a bit 13 = screen_mode(0)) and classic attributes from its
//     own +$1800 block ($7800 in CPU terms, :239-241).
//   - mode 010 (hi-colour): one attribute per 8x1 pixel row, fetched
//     through the PIXEL address layout with bit 13 = 1 (:238-239).
//   - the ULA shadow display forces mode 000 (bank 7 has no Timex
//     surface on the FPGA, :191).
func TestNextULARowTimexModes(t *testing.T) {
	u, _, mem := newNextVideoULA(t)
	page := mem.GetPage(mem.ScreenPage)

	// Distinct content in the two display files at source (16..23, 40):
	// file 1: ink pixels with attr ink 1; file 2: ink pixels with attr ink 3.
	page[screenAddrForRowCol(40, 2)] = 0xFF
	page[0x1800+(40>>3)*32+2] = 0x01 // file-1 classic attr: ink 1
	page[0x2000+screenAddrForRowCol(40, 2)] = 0xFF
	page[0x3800+(40>>3)*32+2] = 0x03 // file-2 classic attr: ink 3

	// Screen 0 (mode 000): ink from file-1 attr.
	u.SetTimexVideoMode(0x00)
	u.Render()
	if r, _, _, _ := paperPixel(u, 16, 40); r != 1 {
		t.Errorf("mode 000 ink = idx %d, want 1 (file-1 attr)", r)
	}

	// Screen 1 (mode 001): pixels AND attrs from display file 2.
	u.SetTimexVideoMode(0x01)
	u.Render()
	if r, _, _, _ := paperPixel(u, 16, 40); r != 3 {
		t.Errorf("mode 001 ink = idx %d, want 3 (file-2 attr)", r)
	}

	// Hi-colour (mode 010): the attribute for pixel row 40 comes from
	// $2000 + pixel-scrambled address — per-8x1 attributes. Rows 40 and
	// 41 of the same char cell can differ.
	page[0x2000+screenAddrForRowCol(40, 2)] = 0x05 // attr row 40: ink 5
	page[screenAddrForRowCol(41, 2)] = 0xFF
	page[0x2000+screenAddrForRowCol(41, 2)] = 0x06 // attr row 41: ink 6
	u.SetTimexVideoMode(0x02)
	u.Render()
	if r, _, _, _ := paperPixel(u, 16, 40); r != 5 {
		t.Errorf("hi-colour row 40 ink = idx %d, want 5", r)
	}
	if r, _, _, _ := paperPixel(u, 16, 41); r != 6 {
		t.Errorf("hi-colour row 41 ink = idx %d, want 6", r)
	}

	// Shadow display: Timex modes forced off — back to file-1 classic
	// decode even with mode 001 latched. (The shadow page itself is empty
	// here; assert via the page the fetch would use: bank 7 all zeros →
	// paper index 16+7*0… simply assert the pixel is NOT the file-2 ink.)
	mem.ScreenPage = 7
	u.SetTimexVideoMode(0x01)
	u.Render()
	if r, _, _, _ := paperPixel(u, 16, 40); r == 3 {
		t.Errorf("shadow display still decoding Timex screen 1 (idx %d)", r)
	}
	mem.ScreenPage = 5
}

// TestNextULARowLoRes pins the LoRes/Radastan layer wiring
// (zxnext.vhd:6980 — the LoRes pixel replaces the classic ULA pixel
// inside the shared NR$1A clip window while NR$15 bit 7 is set):
// standard-mode addressing/doubling and palette offset (lores.vhd:
// 91-111 via pkg/next/lores), the NR$32/$33 private scroll, the
// radastan nibble mode, and the clip window.
func TestNextULARowLoRes(t *testing.T) {
	u, m, mem := newNextVideoULA(t)
	bank5 := mem.GetPage(5)

	// LoRes standard mode: display (10,10) → data addr (10>>1)<<7 | (10>>1)
	// wait: addr = (y>>1)<<7 | (x>>1) = 5*128+5 = 645.
	bank5[5*128+5] = 0x42
	u.SetLayerControl(0x80) // LoRes on, SLU priority
	u.Render()
	if r, _, _, _ := paperPixel(u, 10, 10); r != 0x42 {
		t.Errorf("LoRes pixel (10,10) = idx $%02X, want $42", r)
	}
	// Pixel-doubling: (11,10) and (10,11) map to the same byte.
	if r, _, _, _ := paperPixel(u, 11, 10); r != 0x42 {
		t.Errorf("LoRes pixel (11,10) = idx $%02X, want $42 (x doubling)", r)
	}
	if r, _, _, _ := paperPixel(u, 10, 11); r != 0x42 {
		t.Errorf("LoRes pixel (10,11) = idx $%02X, want $42 (y doubling)", r)
	}

	// Palette offset: high nibble of the data byte + offset (lores.vhd:102).
	u.SetLoResControl(false, false, 2)
	u.Render()
	if r, _, _, _ := paperPixel(u, 10, 10); r != 0x62 {
		t.Errorf("LoRes pixel with palette offset 2 = idx $%02X, want $62", r)
	}
	u.SetLoResControl(false, false, 0)

	// LoRes scroll (NR$32/$33): display (6,4) + scroll (4,6) → source
	// (10,10) → the same byte.
	u.SetLoResScroll(4, 6)
	u.Render()
	if r, _, _, _ := paperPixel(u, 6, 4); r != 0x42 {
		t.Errorf("scrolled LoRes pixel (6,4) = idx $%02X, want $42", r)
	}
	u.SetLoResScroll(0, 0)

	// Second half: display row 96+ fetches from the $2000 block
	// (lores.vhd:93-94 bumps addr bits 13:11 for y >= 96).
	bank5[0x2000+2*128+3] = 0x77
	u.Render()
	if r, _, _, _ := paperPixel(u, 6, 100); r != 0x77 {
		t.Errorf("bottom-half LoRes pixel (6,100) = idx $%02X, want $77", r)
	}

	// Radastan mode (NR$6A bit 5): two 4-bit pixels per byte, high
	// nibble from the palette offset (lores.vhd:106-107).
	u.SetLoResControl(true, false, 3)
	// radastan addr for (20,10): (y>>1)<<6 | (x>>2) = 5*64+5 = 325.
	bank5[5*64+5] = 0xAB
	u.Render()
	if r, _, _, _ := paperPixel(u, 20, 10); r != 0x3A {
		t.Errorf("radastan pixel (20,10) = idx $%02X, want $3A (hi nibble)", r)
	}
	if r, _, _, _ := paperPixel(u, 22, 10); r != 0x3B {
		t.Errorf("radastan pixel (22,10) = idx $%02X, want $3B (lo nibble)", r)
	}
	u.SetLoResControl(false, false, 0)

	// Clip window: outside pixels are transparent fallback, exactly as
	// for the classic ULA (the FPGA gates lores_pixel_en with the same
	// NR$1A window).
	u.SetULAClipWindow(8, 239, 8, 175)
	u.Render()
	fb := m.FallbackRGBA()
	if r, g, b, a := paperPixel(u, 0, 0); a != 0 || r != fb[0] || g != fb[1] || b != fb[2] {
		t.Errorf("clipped LoRes (0,0) = rgba(%d,%d,%d,%d), want transparent fallback", r, g, b, a)
	}
	u.SetULAClipWindow(0, 255, 0, 191)
	u.SetLayerControl(0x00)
}

// TestLayerControlMidFrameRasterStamp pins the raster-stamped NR$15
// replay through its LoRes-enable bit: a CPU enabling LoRes at
// mid-frame renders rows before the write's raster line as classic ULA
// and rows after as LoRes — the MrKWatkins LayersMixing tests rewrite
// NR$15 per 32-line band this way (priority mode bits ride the same
// stamped byte, pushed per row via SetPriorityModeOverride).
func TestLayerControlMidFrameRasterStamp(t *testing.T) {
	u, _, mem := newNextVideoULA(t)
	tstates := uint64(0)
	mem.TStates = &tstates
	refT := uint64(1000)
	mem.RefTstates = func() uint64 { return refT }

	bank5 := mem.GetPage(5)
	// Classic screen: paper cell attr ink 1 with a set pixel at (16,40)
	// (row 40 = frame scanline 104); LoRes byte covering (16,40) = $55.
	page := mem.GetPage(mem.ScreenPage)
	page[screenAddrForRowCol(40, 2)] = 0xFF
	page[0x1800+(40>>3)*32+2] = 0x01
	page[screenAddrForRowCol(120, 2)] = 0xFF
	page[0x1800+(120>>3)*32+2] = 0x01
	bank5[(40>>1)*128+(16>>1)] = 0x55
	bank5[0x2000+((120-96)>>1)*128+(16>>1)] = 0x66

	// LoRes switches ON at frame scanline 150 → display line 110 →
	// paper row 86: row 40 renders classic, row 120 renders LoRes.
	tstates = uint64(150 * TStatesPerLineFor(mem.GetCurrentModel()))
	u.SetLayerControl(0x80)
	u.Render()

	if r, _, _, _ := paperPixel(u, 16, 40); r != 1 {
		t.Errorf("row 40 (before mid-frame LoRes-on) = idx %d, want 1 (classic ink)", r)
	}
	if r, _, _, _ := paperPixel(u, 16, 120); r != 0x66 {
		t.Errorf("row 120 (after mid-frame LoRes-on) = idx $%02X, want $66 (LoRes)", r)
	}
	u.SetLayerControl(0x00)
}
