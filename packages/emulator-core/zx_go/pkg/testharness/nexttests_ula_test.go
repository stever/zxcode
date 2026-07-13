package testharness

// The MrKWatkins/ZXSpectrumNextTests ULA group (Tests/ULA/*): global
// transparency defaults, value-driven ULA palette transparency, the
// NR$4A fallback (border included), the classic screen through
// redefined/raster-flipped Next ULA palettes, and the NR$26/$27 ULA
// hardware scroll + NR$1A clip window.
//
// Colour space: every assertion is in the Next's 9-bit palette
// projection (white = 182,182,182 — see the #144 live-palette render),
// derived from the FPGA palette rules, and cross-checked once against
// the upstream reference captures (real-board photo + MAME 0.282 +
// CSpect; ZEsarUX for BorderTransparencyFallback, whose CSpect capture
// is marked BAD upstream).

import (
	"image"
	"testing"
)

// proj3 scales a 3-bit palette channel to 8 bits the way the FPGA DAC
// does (v<<5 | v<<2 | v>>1): 0,36,73,109,146,182,219,255.
func proj3(v byte) byte { return v<<5 | v<<2 | v>>1 }

// rgb9 projects a 9-bit RRRGGGBBB palette value to RGB.
func rgb9(v uint16) [3]byte {
	return [3]byte{proj3(byte(v>>6) & 7), proj3(byte(v>>3) & 7), proj3(byte(v) & 7)}
}

// rgb332x9 projects an 8-bit RRRGGGBB colour the way the FPGA widens it
// onto the 9-bit bus: low blue bit = OR of the blue pair
// (zxnext.vhd:7214). The identity Layer 2 palette resolves column x of
// the suite's FillLayer2WithTestData gradient to rgb332x9(x).
func rgb332x9(v byte) [3]byte {
	b2 := uint16(v & 3)
	return rgb9(uint16(v)<<1 | (b2>>1 | b2&1))
}

var (
	nineWhite = [3]byte{182, 182, 182}
	nineBlack = [3]byte{0, 0, 0}
)

func imgRGB(img *image.RGBA, x, y int) [3]byte {
	off := y*img.Stride + x*4
	return [3]byte{img.Pix[off], img.Pix[off+1], img.Pix[off+2]}
}

// paperRGB reads paper coordinate (0..255, 0..191) from a 320x240 frame.
func paperRGB(img *image.RGBA, x, y int) [3]byte { return imgRGB(img, 32+x, 24+y) }

// assertBorderUniform samples every pixel of all four border regions of
// a 320x240 frame — the whole-surface rule from the banded-border
// regression: no test may leave a border region unasserted.
func assertBorderUniform(t *testing.T, img *image.RGBA, want [3]byte, label string) {
	t.Helper()
	bad := 0
	for y := 0; y < 240; y++ {
		for x := 0; x < 320; x++ {
			if x >= 32 && x < 288 && y >= 24 && y < 216 {
				continue
			}
			if got := imgRGB(img, x, y); got != want {
				if bad == 0 {
					t.Errorf("%s: border (%d,%d) = %v, want %v", label, x, y, got, want)
				}
				bad++
			}
		}
	}
	if bad > 1 {
		t.Errorf("%s: %d border pixels off in total", label, bad)
	}
}

// pressMatrix holds a matrix key for hold frames, releases it, then
// settles. TFalBUla's waitForN debounces 10 frames before polling, so
// hold must stay below that to advance exactly one phase.
func pressMatrix(h *Harness, row int, mask byte, hold, settle int) {
	h.kbd.PressMatrixKey(row, mask, true)
	h.RunFrames(hold)
	h.kbd.PressMatrixKey(row, mask, false)
	h.RunFrames(settle)
}

func readNextReg(h *Harness, reg byte) byte {
	h.ULA().WritePort(0x243B, reg)
	v, _ := h.ULA().ReadPort(0x253B)
	return v
}

// TestNexttestsULADefaultTransparency — ULA/DefaultTransparency: a
// classic bright-magenta paper over a Layer 2 gradient must stay OPAQUE,
// because the boot ULA palette defines bright magenta as %111'001'111
// ($E7 projection ≠ the default NR$14 $E3). Board photo shows solid
// magenta; MAME/CSpect/ZEsarUX all render (255,36,255). This test is
// what forced the classicRGB333 bright-magenta fix.
func TestNexttestsULADefaultTransparency(t *testing.T) {
	h := runNexttestsSNX(t, "DefTrans.snx", 60)
	img := h.ScreenImage()

	// BORDER 7 through the default palette: 9-bit white everywhere.
	assertBorderUniform(t, img, nineWhite, "white border")

	// Whole paper: bright magenta (255,36,255) or the black ink of the
	// two text lines — never a Layer 2 gradient colour.
	magenta := [3]byte{255, 36, 255}
	magentaCount, textTop, textBottom := 0, 0, 0
	for y := 0; y < 192; y++ {
		for x := 0; x < 256; x++ {
			got := paperRGB(img, x, y)
			switch got {
			case magenta:
				magentaCount++
			case nineBlack:
				switch {
				case y < 8:
					textTop++
				case y >= 184:
					textBottom++
				default:
					t.Fatalf("black ink at (%d,%d) outside the text rows", x, y)
				}
			default:
				t.Fatalf("paper (%d,%d) = %v — Layer 2 leaking through opaque magenta", x, y, got)
			}
		}
	}
	if magentaCount < 45000 || textTop < 50 || textBottom < 20 {
		t.Errorf("scene mix off: magenta=%d textTop=%d textBottom=%d", magentaCount, textTop, textBottom)
	}
}

// cpalScene asserts the shared ChangePaletteTransparency scene: the ULA
// paper made transparent via a palette redefinition to $E3 reveals the
// Layer 2 gradient (identity palette: column x = rgb332x9(x)), except
// column 227 where Layer 2 itself carries $E3 and the NR$4A fallback
// (raw cyan $1F) shows; the border resolves through the redefined
// palette entry too.
func cpalScene(t *testing.T, h *Harness, border [3]byte, label string) {
	t.Helper()
	img := h.ScreenImage()
	assertBorderUniform(t, img, border, label+" border")
	cyan := [3]byte{0, 255, 255}
	for y := 0; y < 192; y++ {
		for x := 0; x < 256; x++ {
			want := rgb332x9(byte(x))
			if x == 227 { // Layer 2 pixel $E3 → transparent → fallback
				want = cyan
			}
			if got := paperRGB(img, x, y); got != want {
				t.Fatalf("%s: paper (%d,%d) = %v, want %v", label, x, y, got, want)
			}
		}
	}
}

// TestNexttestsULAChangePaletteTransparency — ULA/ChangePaletteTransparency:
// ULANext ink-mask 7, paper 7 (entry 135) redefined to $E3 → the whole
// paper is transparent over Layer 2; the BORDER 7 resolves through the
// same transparent entry 135 → fallback cyan.
func TestNexttestsULAChangePaletteTransparency(t *testing.T) {
	h := runNexttestsSNX(t, "CPalTran.snx", 60)
	cpalScene(t, h, [3]byte{0, 255, 255}, "CPalTran")
}

// TestNexttestsULAChangePaletteTransparencyV2 — the v2 variant: ink-mask
// 15 decodes attr $38 as INK 8 / PAPER 3; entry 131 (paper 3) is the
// transparent one and entry 135 (the BORDER 7 source) is redefined to
// green %000'100'00 instead — proving the border picks entry 128+border
// rather than following the paper.
func TestNexttestsULAChangePaletteTransparencyV2(t *testing.T) {
	h := runNexttestsSNX(t, "CPalTrV2.snx", 60)
	cpalScene(t, h, [3]byte{0, 146, 0}, "CPalTrV2")
}

// TestNexttestsULAChangePaletteTransparencyV3 — the v3 variant: ULANext
// stays OFF while palette entry 128+7 is set to $E3. Classic decode uses
// entries 16..31 for paper, so NOTHING may become transparent from that
// write — white paper + white border. The informational text is drawn
// with INK 0 whose entry 0 IS redefined to $E3, so the glyph pixels
// alone reveal the Layer 2 gradient ("rainbow text").
func TestNexttestsULAChangePaletteTransparencyV3(t *testing.T) {
	h := runNexttestsSNX(t, "CPalTrV3.snx", 60)
	img := h.ScreenImage()
	assertBorderUniform(t, img, nineWhite, "CPalTrV3 border")
	rainbow := 0
	for y := 0; y < 192; y++ {
		for x := 0; x < 256; x++ {
			got := paperRGB(img, x, y)
			if got == nineWhite {
				continue
			}
			// Non-white pixels are only the transparent text glyphs on
			// the two text rows, and they must show the Layer 2 column.
			if y >= 8 && y < 184 {
				t.Fatalf("non-white pixel %v at (%d,%d) outside the text rows — ULANext paper decode leaking while OFF", got, x, y)
			}
			want := rgb332x9(byte(x))
			if x == 227 { // Layer 2's own $E3 column → fallback cyan
				want = [3]byte{0, 255, 255}
			}
			if got != want {
				t.Fatalf("text glyph at (%d,%d) = %v, want Layer 2 column %v", x, y, got, want)
			}
			rainbow++
		}
	}
	if rainbow < 50 {
		t.Errorf("only %d rainbow text pixels — transparent INK 0 not revealing Layer 2", rainbow)
	}
}

// TestNexttestsULABorderTransparencyFallback — ULA/BorderTransparencyFallback:
// three key-driven phases of border/paper transparency-fallback
// behaviour (ZEsarUX capture is the good reference; CSpect's is marked
// BAD upstream). Phase 1: ULANext ink-mask 7, entry 128 = NR$14 = $AA →
// BORDER 0 and the right (attr $07) paper half show the $1C green
// fallback, the left (attr $38) half stays default white. Phase 2:
// ink-mask 255 has no canonical paper → whole paper takes the fallback.
// Phase 3: ULANext off → classic decode; nothing matches $AA, cyan
// border, black-and-white halves.
func TestNexttestsULABorderTransparencyFallback(t *testing.T) {
	h := runNexttestsSNX(t, "TFalBUla.snx", 60)
	green := [3]byte{0, 255, 0} // fallback $1C = %000'111'00

	// Sample paper blocks away from every text row (text lives on char
	// rows 2,3,6 and 21..23): char rows 8..19, both halves.
	assertHalves := func(wantLeft, wantRight [3]byte, label string) {
		t.Helper()
		img := h.ScreenImage()
		for y := 64; y < 160; y++ {
			for x := 8; x < 120; x++ {
				if got := paperRGB(img, x, y); got != wantLeft {
					t.Fatalf("%s: left half (%d,%d) = %v, want %v", label, x, y, got, wantLeft)
				}
			}
			for x := 136; x < 248; x++ {
				if got := paperRGB(img, x, y); got != wantRight {
					t.Fatalf("%s: right half (%d,%d) = %v, want %v", label, x, y, got, wantRight)
				}
			}
		}
	}

	// Phase 1: green border, white left half, green (fallback) right half.
	assertBorderUniform(t, h.ScreenImage(), green, "phase 1 border")
	assertHalves(nineWhite, green, "phase 1")

	// Phase 2 (press N, shorter than the 10-frame debounce): full-ink
	// mask → the whole paper picks the fallback.
	pressMatrix(h, 7, 0x08, 5, 20)
	assertBorderUniform(t, h.ScreenImage(), green, "phase 2 border")
	assertHalves(green, green, "phase 2")

	// Phase 3: Enhanced ULA off — cyan border, classic B&W halves; the
	// Enhanced-ULA palette/transparency state must stop mattering.
	pressMatrix(h, 7, 0x08, 5, 20)
	assertBorderUniform(t, h.ScreenImage(), [3]byte{0, 182, 182}, "phase 3 border")
	assertHalves(nineWhite, nineBlack, "phase 3")
}

// TestNexttestsULAClassicPaletized — ULA/ClassicPaletized: the classic
// screen through the Next ULA palettes with raster-timed effects. Each
// frame the CPU displays the FIRST (default) palette for the top half
// and flips NR$43 to the SECOND (custom gradient) palette at mid-screen,
// while drawing raster border rainbows beside the attribute thirds.
// Exercises the raster-stamped displayed-palette replay; upstream itself
// notes stripe POSITIONS may drift (even real cores drift), so bands are
// asserted by order and rough extent, exact rows by content.
func TestNexttestsULAClassicPaletized(t *testing.T) {
	h := runNexttestsSNX(t, "Ula_Pal.snx", 100)
	img := h.ScreenImage()

	// The custom second palette (PalDef in the upstream source, octal):
	// ink 0-15 and paper 0-15 gradients written via NR$44 pairs.
	custInk := []uint16{0o700, 0o610, 0o520, 0o430, 0o340, 0o250, 0o160, 0o070,
		0o170, 0o061, 0o052, 0o043, 0o034, 0o025, 0o016, 0o007}
	custPaper := []uint16{0o707, 0o617, 0o527, 0o437, 0o347, 0o257, 0o167, 0o077,
		0o177, 0o176, 0o275, 0o374, 0o473, 0o572, 0o671, 0o770}

	// 1. The mid-screen palette flip: the empty middle band (attr $38,
	// paper 7) renders default white above the flip and the custom
	// paper-7 raw cyan below. The flip lands at paper row ~95 (NR$43
	// write at ~36200 T-states → frame scanline 158-159).
	switchRow := -1
	for y := 64; y < 128; y++ {
		switch paperRGB(img, 128, y) {
		case nineWhite:
			continue
		case rgb9(0o077):
			switchRow = y
		default:
			t.Fatalf("middle band row %d = %v, want white or raw cyan", y, paperRGB(img, 128, y))
		}
		break
	}
	if switchRow < 90 || switchRow > 100 {
		t.Errorf("palette flip at paper row %d, want ~95 (mid-screen NR$43 raster stamp)", switchRow)
	}

	// 2. Attribute cells: the thirds show every INK/PAPER combination as
	// a 2px paper frame around a 4x4 ink square. Sample the ink centre
	// (8c+3, 8r+3) and the frame (8c, 8r+7). Non-flash cells only (flash
	// phase depends on frame parity). Top third = first palette (classic
	// colours, incl. the $E7 bright magenta); bottom third = second.
	classic := func(bright, idx byte) [3]byte {
		v := []uint16{0x000, 0x005, 0x140, 0x145, 0x028, 0x02D, 0x168, 0x16D,
			0x000, 0x007, 0x1C0, 0x1CF, 0x038, 0x03F, 0x1F8, 0x1FF}[bright*8+idx]
		return rgb9(v)
	}
	type cell struct {
		attr       byte
		row, col   int
		ink, paper [3]byte
	}
	cells := []cell{
		// Top third (char rows 0-7, attr = row*32+col), first palette.
		{0x07, 0, 7, classic(0, 7), classic(0, 0)},
		{0x2A, 1, 10, classic(0, 2), classic(0, 5)},
		{0x47, 2, 7, classic(1, 7), classic(1, 0)},
		// Bright magenta PAPER (attr $58): the DefaultTransparency fix
		// seen through the classic decode.
		{0x58, 2, 24, classic(1, 0), classic(1, 3)},
		// Bottom third (char rows 16-23), second palette: ULANext is
		// off, so ink = bright<<3|ink and paper = 16 + bright<<3|paper
		// resolve through the custom gradient entries.
		{0x07, 16, 7, rgb9(custInk[7]), rgb9(custPaper[0])},
		{0x2A, 17, 10, rgb9(custInk[2]), rgb9(custPaper[5])},
		{0x47, 18, 7, rgb9(custInk[15]), rgb9(custPaper[8])},
	}
	for _, c := range cells {
		if got := paperRGB(img, c.col*8+3, c.row*8+3); got != c.ink {
			t.Errorf("attr $%02X cell (%d,%d) ink = %v, want %v", c.attr, c.col, c.row, got, c.ink)
		}
		if got := paperRGB(img, c.col*8, c.row*8+7); got != c.paper {
			t.Errorf("attr $%02X cell (%d,%d) paper = %v, want %v", c.attr, c.col, c.row, got, c.paper)
		}
	}

	// 3. The border rainbows, as the deduped top-to-bottom colour
	// sequence of the left border column: the top rainbow runs through
	// the FIRST palette (classic border colours), the bottom one through
	// the SECOND (custom paper entries; BORDER GREEN's edge lines land
	// on custom entry 20 = light blue, matching the upstream ReadMe's
	// "green/light blue" note), and the border after the mid-screen flip
	// turns raw cyan (white through the custom palette).
	var seq [][3]byte
	for y := 0; y < 240; y++ {
		c := imgRGB(img, 4, y)
		if len(seq) == 0 || seq[len(seq)-1] != c {
			seq = append(seq, c)
		}
	}
	want := [][3]byte{
		nineWhite,                                          // top border
		rgb9(0o050),                                        // green edge
		rgb9(0o000), rgb9(0o005), rgb9(0o500), rgb9(0o505), // bands 0-3
		rgb9(0o050), rgb9(0o055), rgb9(0o550), // bands 4-6
		nineWhite,   // band 7 + white gap
		rgb9(0o050), // closing green edge
		nineWhite,   // gap to mid-screen
		rgb9(0o077), // white border through the SECOND palette
		rgb9(0o347), // green edge through the second palette (light blue)
		rgb9(custPaper[0]), rgb9(custPaper[1]), rgb9(custPaper[2]), rgb9(custPaper[3]),
		rgb9(custPaper[4]), rgb9(custPaper[5]), rgb9(custPaper[6]), rgb9(custPaper[7]),
		rgb9(0o347), // closing edge
		rgb9(0o077), // bottom border, still second palette
	}
	if len(seq) != len(want) {
		t.Fatalf("left border colour sequence has %d runs, want %d: %v", len(seq), len(want), seq)
	}
	for i := range want {
		if seq[i] != want[i] {
			t.Errorf("border sequence[%d] = %v, want %v", i, seq[i], want[i])
		}
	}
}

// TestNexttestsULAScroll — ULA/UlaScroll: the NR$26/$27 ULA hardware
// scroll and the NR$1A clip window ([8,8]->[239,175]: one hidden
// char row/column at top/left — yellow-paper markers — and two at
// bottom/right — "///" stripe markers). R skips the scroll animation
// (registers back to 0, green border); OPQA then scroll interactively,
// and the harness cross-checks the rendered shift against the live
// NR$26/$27 read-back. M cycles NR$69 display modes; one press shows the
// ZX128 shadow screen (bank 7) copy with its own highlight row.
func TestNexttestsULAScroll(t *testing.T) {
	h := runNexttestsSNX(t, "UlaScrol.snx", 40)
	pressMatrix(h, 2, 0x08, 10, 10) // R: skip the animation
	if b := h.ULA().BorderColour; b != 4 {
		t.Fatalf("border = %d after R, want 4 (green = interactive phase)", b)
	}
	if x, y := readNextReg(h, 0x26), readNextReg(h, 0x27); x != 0 || y != 0 {
		t.Fatalf("scroll registers after R = (%d,%d), want (0,0)", x, y)
	}

	img := h.ScreenImage()
	green := [3]byte{0, 182, 0} // classic green border AND the $14 fallback
	assertBorderUniform(t, img, green, "green border")

	// Clip window: the hidden edges show the NR$4A fallback (also green)
	// — the yellow top/left markers and the "///" bottom/right stripes
	// must NOT render. Inclusive bounds: x=239 keeps the 1px right-edge
	// line drawn at source column 239.
	for _, p := range []struct{ x, y int }{
		{0, 100}, {7, 100}, {240, 100}, {255, 100},
		{100, 0}, {100, 7}, {100, 176}, {100, 191},
	} {
		if got := paperRGB(img, p.x, p.y); got != green {
			t.Errorf("clipped paper (%d,%d) = %v, want fallback green", p.x, p.y, got)
		}
	}
	yellow := [3]byte{255, 255, 0}
	for y := 0; y < 192; y++ {
		for x := 0; x < 256; x++ {
			if paperRGB(img, x, y) == yellow {
				t.Fatalf("yellow clip marker visible at (%d,%d) — ULA clip window not applied", x, y)
			}
		}
	}
	// The dithered grid is visible inside the window.
	grid := 0
	for y := 10; y < 120; y++ {
		for x := 10; x < 120; x++ {
			if paperRGB(img, x, y) == nineBlack {
				grid++
			}
		}
	}
	if grid < 1000 {
		t.Fatalf("only %d grid pixels — scene not drawn", grid)
	}
	base := image.NewRGBA(img.Bounds())
	copy(base.Pix, img.Pix)

	// Scroll right via P: every visible pixel must equal the base frame
	// shifted by the live NR$26 value (display (x,y) shows source
	// (x+NR$26) mod 256; the clip stays put in display space).
	pressMatrix(h, 5, 0x01, 20, 5) // P
	dx := int(readNextReg(h, 0x26))
	if dx == 0 {
		t.Fatalf("NR$26 still 0 after holding P")
	}
	img = h.ScreenImage()
	for y := 8; y <= 175; y++ {
		for x := 8; x+dx <= 239; x++ {
			if got, want := paperRGB(img, x, y), paperRGB(base, x+dx, y); got != want {
				t.Fatalf("X scroll %d: (%d,%d) = %v, want base(%d,%d) = %v", dx, x, y, got, x+dx, y, want)
			}
		}
	}

	// Scroll down via A on top: combined (dx, dy) source mapping.
	pressMatrix(h, 1, 0x01, 12, 5) // A
	dy := int(readNextReg(h, 0x27))
	if dy == 0 {
		t.Fatalf("NR$27 still 0 after holding A")
	}
	img = h.ScreenImage()
	for y := 8; y+dy <= 175; y++ {
		for x := 8; x+dx <= 239; x++ {
			if got, want := paperRGB(img, x, y), paperRGB(base, x+dx, y+dy); got != want {
				t.Fatalf("XY scroll (%d,%d): (%d,%d) = %v, want %v", dx, dy, x, y, got, want)
			}
		}
	}

	// M once: NR$69 bit 6 selects the ZX128 shadow display (bank 7).
	// The copy in bank 7 highlights the "ULA BANK7" legend row (char row
	// 15) instead of BANK4's row 14 — the visible switch proves the
	// display source really changed. R first: it resets the interactive
	// scroll back to (0,0) so the highlight cell is sampled unshifted.
	pressMatrix(h, 2, 0x08, 5, 10) // R: reset scroll
	if x, y := readNextReg(h, 0x26), readNextReg(h, 0x27); x != 0 || y != 0 {
		t.Fatalf("scroll after second R = (%d,%d), want (0,0)", x, y)
	}
	pressMatrix(h, 7, 0x04, 5, 20) // M
	if nr69 := readNextReg(h, 0x69); nr69 != 0x40 {
		t.Fatalf("NR$69 after M = $%02X, want $40 (shadow ULA)", nr69)
	}
	img = h.ScreenImage()
	brightBlue := [3]byte{0, 0, 255}
	if got := paperRGB(base, 24*8, 15*8+7); got != nineWhite {
		t.Errorf("bank 4 char (24,15) paper = %v, want white (no highlight)", got)
	}
	if got := paperRGB(img, 24*8, 15*8+7); got != brightBlue {
		t.Errorf("bank 7 char (24,15) paper = %v, want bright blue highlight", got)
	}
}
