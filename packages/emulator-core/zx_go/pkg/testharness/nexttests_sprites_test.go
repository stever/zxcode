package testharness

import (
	"fmt"
	"image"
	"strings"
	"testing"
)

// --- Sprites group: MrKWatkins/ZXSpectrumNextTests Tests/Sprites/ --------
//
// Five static visual scenes (SpritTra, SpritRel, SpritBig, SprBig4b,
// SprDelay), each verified by eye once against the upstream reference
// captures (real-board photos + MAME 0.282), then pinned here with
// per-pixel assertions at coordinates derived from each test's Main.asm.
//
// Coordinates: with sprites active the harness ScreenImage is the full
// 320x256 Next frame, so image (x,y) IS the sprite/frame coordinate —
// the paper's top-left corner (sprite [32,32]) is image (32,32). RGB
// values are the FPGA's 9-bit palette projection (each 3-bit channel
// scaled, low blue bit = OR of the two blue bits): 182 = %101,
// 219 = %110, 109 = %011, 73 = %010, 255 = %111, 36 = %001.

// spriteFrameChecker returns a pixel asserter over the 320x256 frame.
func spriteFrameChecker(t *testing.T, img *image.RGBA) func(what string, x, y int, want [3]byte) {
	t.Helper()
	if img.Rect.Dx() != 320 || img.Rect.Dy() != 256 {
		t.Fatalf("expected the 320x256 over-border frame, got %dx%d", img.Rect.Dx(), img.Rect.Dy())
	}
	return func(what string, x, y int, want [3]byte) {
		px := img.RGBAAt(x, y)
		if got := [3]byte{px.R, px.G, px.B}; got != want {
			t.Errorf("%s at frame (%d,%d): got %v, want %v", what, x, y, got, want)
		}
	}
}

// TestNexttestsSpritesTransparency — Sprites/Transparency: a 16x16 8bpp
// sprite at frame (64,64) built from palette indexes 1 and 2 in a 2x2
// checker (TL/BR = index 2, TR/BL = index 1). The program then sets
// NR$4B = 2, so the TL/BR squares must vanish (white paper shows; RED
// there means sprite transparency failed) while TR/BL render index 1,
// which was set green because the NR$4B default read back $E3 (yellow
// there means the default-read failed). Reference: Board_core2.00.26.png.
func TestNexttestsSpritesTransparency(t *testing.T) {
	h := runNexttestsSNX(t, "SpritTra.snx", 100)
	if text := h.ScreenText(); !strings.Contains(text, "[SpritTra.snx]") {
		t.Errorf("test banner missing:\n%s", text)
	}
	check := spriteFrameChecker(t, h.ScreenImage())
	white := [3]byte{182, 182, 182}
	green := [3]byte{0, 109, 0} // %00001100 through the 9-bit projection
	// Centres of the four 8x8 squares.
	check("top-left (transparent)", 67, 67, white)
	check("top-right (green = default $E3 read OK)", 75, 67, green)
	check("bottom-left (green)", 67, 75, green)
	check("bottom-right (transparent)", 75, 75, white)
	// Whole-surface: border and paper untouched on all four sides.
	check("left border", 10, 128, white)
	check("right border", 310, 128, white)
	check("top border", 160, 10, white)
	check("bottom border", 160, 245, white)
	check("paper background", 200, 100, white)
}

// TestNexttestsSpritesRelative — Sprites/Relative: composite relative
// sprites (anchor + relatives), palette-offset relativity, relative
// pattern names, scales, invisibility propagation and the over-border
// dot. The ULA draws a one-pixel black outline exactly around the
// expected sprite rectangle (frame [80,48]..[223,127]) and the sprites
// must fill it solid green — 8bpp sprites lighter (palette $5D), 4bpp
// darker ($1C) — in USL order (ULA labels/dots on top). Hidden sprites
// are all red variants, so ANY red (8b $E9 / 4b $E0) or violet
// ($A2 = "unexpected pixel") anywhere is a failure, as is green outside
// the rectangle. Reference: Board_core2.00.27.png / MAME0.282.jpg.
//
// This scene is also the adjudicator for the former "sprites composite
// 8 rows lower" known-gaps row: the sprite fill sits exactly inside the
// ULA-drawn outline on both axes (green 48..126 with the outline at 47
// and 127, the last sprite row hidden under the USL outline — identical
// relation in the MAME capture), so the sprite frame is aligned
// correctly and the row was a coordinate-convention misreading.
func TestNexttestsSpritesRelative(t *testing.T) {
	h := runNexttestsSNX(t, "SpritRel.snx", 100)
	text := h.ScreenText()
	for _, want := range []string{"[SpritRel.snx]", "machineID:10"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in screen text", want)
		}
	}
	img := h.ScreenImage()
	check := spriteFrameChecker(t, img)

	fallback := [3]byte{182, 182, 182} // NR$4A = $B6 (ULA paper is transparent)
	border := [3]byte{109, 109, 109}   // BORDER palette entry redefined to grey
	black := [3]byte{0, 0, 0}
	green8 := [3]byte{73, 255, 109} // 8bpp $22 -> palette $5D
	green4 := [3]byte{0, 255, 0}    // 4bpp green -> palette $1C
	blue := [3]byte{0, 0, 182}      // the dot sprite's $55 -> palette $02

	// The ULA outline hugging the sprite rectangle, and green just inside.
	check("outline left", 79, 100, black)
	check("outline right", 223, 100, black)
	check("outline top", 150, 47, black)
	check("outline bottom", 150, 127, black)
	check("fill inside left edge", 80, 100, green8)
	check("fill inside top edge", 150, 48, green8)
	check("fill inside bottom edge", 150, 126, green8)

	// Distinctive sprites (frame positions from the ReadMe map):
	check("sprite 7 (8x1 scale) [96,48]", 120, 52, green8)
	check("sprite 5 (2x4 anchor) [144,64]", 150, 80, green8)
	check("sprite B (2x2) [176,80]", 180, 90, green4)
	check("sprite C (4b HI, 1x4) [208,64]", 212, 90, green4)
	check("sprite H (rel name -1 + rel pal) [112,64]", 116, 68, green4)
	check("sprite J (4RG0.HI) [128,64]", 132, 68, green4)
	check("sprite K (rel pal, 2x1) [176,64]", 190, 70, green4)
	check("sprite N (pal offset wrap) [192,112]", 200, 120, green4)

	// Sprite A's cell [176,112]: 4bpp green under the ULA dots — no other
	// colour allowed in the cell.
	for y := 112; y < 128; y++ {
		for x := 176; x < 192; x++ {
			px := img.RGBAAt(x, y)
			c := [3]byte{px.R, px.G, px.B}
			if c != green4 && c != black {
				t.Fatalf("sprite A cell: unexpected %v at (%d,%d)", c, x, y)
			}
		}
	}

	// The over-border dot (sprite X, anchor [286,222]): its 2x4 middle
	// rows span frame x 286..289 — x 288/289 lie in the right border and
	// rows 224/225 in the bottom border, proving over-border rendering.
	check("dot row 222", 287, 222, blue)
	check("dot row 223 paper edge", 287, 223, blue)
	check("dot in right border", 288, 223, blue)
	check("dot in bottom border", 288, 224, blue)
	check("dot bottom row", 287, 225, blue)
	check("border past the dot", 290, 223, border)

	// Hidden/invisible sprites (0 without anchor, 3/6/D/I/M invisible,
	// E invisible anchor) are red patterns; the whole-palette sentinel is
	// violet. None may appear anywhere; green may not leak outside the
	// rectangle (the X dot is blue, so greens only inside).
	red8 := [3]byte{255, 73, 109}
	red4 := [3]byte{255, 0, 0}
	violet := [3]byte{182, 0, 182}
	for y := 0; y < 256; y++ {
		for x := 0; x < 320; x++ {
			px := img.RGBAAt(x, y)
			c := [3]byte{px.R, px.G, px.B}
			if c == red8 || c == red4 || c == violet {
				t.Fatalf("forbidden colour %v at (%d,%d): an invisible/hidden sprite rendered", c, x, y)
			}
			if (c == green8 || c == green4) && !(x >= 80 && x <= 223 && y >= 48 && y <= 127) {
				t.Fatalf("green sprite pixel outside the rectangle at (%d,%d)", x, y)
			}
		}
	}

	// Whole-surface: grey border on all four sides, fallback-white paper.
	check("top border", 160, 10, border)
	check("bottom border", 160, 245, border)
	check("left border", 10, 100, border)
	check("right border", 310, 100, border)
	check("empty paper", 150, 140, fallback)
}

// bigSpriteGroups are the eight anchor positions of Sprites/BigSprite
// and BigSprite4b (BigSpritesPos in both Main.asm files), with the
// anchor transform each group applies (x = X mirror, y = Y mirror,
// r = rotate). A ninth, invisible big sprite sits at (75,100).
var bigSpriteGroups = [8]struct {
	name   string
	px, py int
}{
	{"---", 35, 55}, {"--r", 115, 55}, {"-y-", 195, 55}, {"-yr", 275, 55},
	{"x--", 35, 145}, {"x-r", 115, 145}, {"xy-", 195, 145}, {"xyr", 275, 145},
}

// TestNexttestsSpritesBigSprite — Sprites/BigSprite: a 23x25 big sprite
// of 10 relative sub-sprites ("b" glyphs; blue anchor, coloured arms
// clockwise) replicated eight times with every anchor mirror/rotate
// combination — the relatives must transform as one rigid body. The
// per-group assertion table pins each colour's bounding box (sampled
// from the render after eyeball-matching board_core2.00.27.png): a
// transform error moves an arm's box; a palette-relativity error
// changes its colour. The ninth (invisible) big sprite and the red
// sub-sprite must not appear; one violet border sprite sits at frame
// (0,224) proving over-border + the "invalid colour" path.
func TestNexttestsSpritesBigSprite(t *testing.T) {
	h := runNexttestsSNX(t, "SpritBig.snx", 100)
	text := h.ScreenText()
	for _, want := range []string{"[SpritBig.snx]", "showAll", "clip", "priority", "depart"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in screen text", want)
		}
	}
	img := h.ScreenImage()
	check := spriteFrameChecker(t, img)

	// Sub-sprite colours (palette entries the test installs), as rendered.
	colours := map[string][3]byte{
		"blue":       {0, 0, 255},
		"red":        {219, 0, 0},
		"orange":     {219, 73, 0},
		"yellow":     {182, 146, 0},
		"lightYell":  {219, 219, 0},
		"lightGreen": {73, 255, 109},
		"green":      {0, 219, 0},
		"cyan":       {0, 219, 182},
		"lightBlue":  {73, 109, 255},
	}
	// Expected bounding box of each colour per group: {x0,y0,x1,y1}.
	want := map[string]map[string][4]int{
		"---": {"blue": {35, 55, 41, 63}, "red": {29, 47, 35, 55}, "orange": {37, 47, 43, 55}, "yellow": {41, 49, 49, 55}, "lightYell": {41, 58, 49, 64}, "lightGreen": {41, 63, 47, 71}, "green": {33, 63, 39, 71}, "cyan": {27, 63, 35, 69}, "lightBlue": {27, 54, 35, 60}},
		"--r": {"blue": {122, 55, 130, 61}, "red": {130, 49, 138, 55}, "orange": {130, 57, 138, 63}, "yellow": {130, 61, 136, 69}, "lightYell": {121, 61, 127, 69}, "lightGreen": {114, 61, 122, 67}, "green": {114, 53, 122, 59}, "cyan": {116, 47, 122, 55}, "lightBlue": {125, 47, 131, 55}},
		"-y-": {"blue": {195, 62, 201, 70}, "red": {189, 70, 195, 78}, "orange": {197, 70, 203, 78}, "yellow": {201, 70, 209, 76}, "lightYell": {201, 61, 209, 67}, "lightGreen": {201, 54, 207, 62}, "green": {193, 54, 199, 62}, "cyan": {187, 56, 195, 62}, "lightBlue": {187, 65, 195, 71}},
		"-yr": {"blue": {282, 64, 290, 70}, "red": {290, 70, 298, 76}, "orange": {290, 62, 298, 68}, "yellow": {290, 56, 296, 64}, "lightYell": {281, 56, 287, 64}, "lightGreen": {274, 58, 282, 64}, "green": {274, 66, 282, 72}, "cyan": {276, 70, 282, 78}, "lightBlue": {285, 70, 291, 78}},
		"x--": {"blue": {44, 145, 50, 153}, "red": {50, 137, 56, 145}, "orange": {42, 137, 48, 145}, "yellow": {36, 139, 44, 145}, "lightYell": {36, 148, 44, 154}, "lightGreen": {38, 153, 44, 161}, "green": {46, 153, 52, 161}, "cyan": {50, 153, 58, 159}, "lightBlue": {50, 144, 58, 150}},
		"x-r": {"blue": {115, 145, 123, 151}, "red": {107, 139, 115, 145}, "orange": {107, 147, 115, 153}, "yellow": {109, 151, 115, 159}, "lightYell": {118, 151, 124, 159}, "lightGreen": {123, 151, 131, 157}, "green": {123, 143, 131, 149}, "cyan": {123, 137, 129, 145}, "lightBlue": {114, 137, 120, 145}},
		"xy-": {"blue": {204, 152, 210, 160}, "red": {210, 160, 216, 168}, "orange": {202, 160, 208, 168}, "yellow": {196, 160, 204, 166}, "lightYell": {196, 151, 204, 157}, "lightGreen": {198, 144, 204, 152}, "green": {206, 144, 212, 152}, "cyan": {210, 146, 218, 152}, "lightBlue": {210, 155, 218, 161}},
		"xyr": {"blue": {275, 154, 283, 160}, "red": {267, 160, 275, 166}, "orange": {267, 152, 275, 158}, "yellow": {269, 146, 275, 154}, "lightYell": {278, 146, 284, 154}, "lightGreen": {283, 148, 291, 154}, "green": {283, 156, 291, 162}, "cyan": {283, 160, 289, 168}, "lightBlue": {274, 160, 280, 168}},
	}
	rgbName := func(c [3]byte) (string, bool) {
		for n, v := range colours {
			if v == c {
				return n, true
			}
		}
		return "", false
	}
	for _, g := range bigSpriteGroups {
		got := map[string][4]int{}
		for y := g.py - 20; y < g.py+25; y++ {
			for x := g.px - 20; x < g.px+25; x++ {
				px := img.RGBAAt(x, y)
				name, ok := rgbName([3]byte{px.R, px.G, px.B})
				if !ok {
					continue
				}
				b, seen := got[name]
				if !seen {
					got[name] = [4]int{x, y, x, y}
					continue
				}
				b[0] = min(b[0], x)
				b[1] = min(b[1], y)
				b[2] = max(b[2], x)
				b[3] = max(b[3], y)
				got[name] = b
			}
		}
		for name, wb := range want[g.name] {
			if got[name] != wb {
				t.Errorf("group %s: %s arm box = %v, want %v", g.name, name, got[name], wb)
			}
		}
	}

	// The ninth big sprite (invisible, anchored at 75,100) must leave its
	// area black, and the red sub-sprite pattern ($02 square) must not
	// appear anywhere in the paperless scene.
	for y := 85; y < 133; y++ {
		for x := 60; x < 113; x++ {
			px := img.RGBAAt(x, y)
			if px.R != 0 || px.G != 0 || px.B != 0 {
				t.Fatalf("invisible ninth big sprite rendered at (%d,%d): %v", x, y, px)
			}
		}
	}

	// The violet "invalid colour" border sprite at frame (0,224) — in the
	// left border AND the bottom-border rows, over-border on.
	check("violet border sprite", 1, 225, [3]byte{182, 0, 182})
	check("border background", 10, 240, [3]byte{36, 36, 36})
}

// TestNexttestsSpritesBigSprite4b — Sprites/BigSprite4b: the same
// eight-orientation big-sprite rig with 4bpp "Golden Wings" graphics:
// pattern-relative names crossing the N6 half boundary (4.5 + 0.5 = 5.0
// per the ReadMe), palette offsets saturating clockwise, plus four
// border-parked pattern-display sprites and a solid red square at the
// bottom left. The 32-colour art makes arm-by-arm colour boxes
// impractical, so each group pins: exact pixel count, exact bounding
// box (the rotate parity shifts it by 2px), 32 distinct colours, and
// five orientation-sensitive sample pixels — sampled from the render
// after eyeball-matching board_core3.1.5.jpg. Reference also confirms
// the invisible ninth sprite leaves (75,100) empty.
func TestNexttestsSpritesBigSprite4b(t *testing.T) {
	h := runNexttestsSNX(t, "SprBig4b.snx", 100)
	if text := h.ScreenText(); !strings.Contains(text, "[SprBig4b.snx]") {
		t.Errorf("test banner missing:\n%s", text)
	}
	img := h.ScreenImage()
	check := spriteFrameChecker(t, img)

	ulaText := map[[3]byte]bool{
		{0, 0, 0}: true, {36, 36, 36}: true, {182, 182, 182}: true,
	}
	wantStats := map[string]struct {
		count int
		box   [4]int
	}{
		"---": {1332, [4]int{14, 43, 55, 84}},
		"--r": {1327, [4]int{92, 43, 133, 84}},
		"-y-": {1332, [4]int{174, 41, 215, 82}},
		"-yr": {1327, [4]int{252, 41, 293, 82}},
		"x--": {1332, [4]int{12, 133, 53, 174}},
		"x-r": {1327, [4]int{94, 133, 135, 174}},
		"xy-": {1332, [4]int{172, 131, 213, 172}},
		"xyr": {1327, [4]int{254, 131, 295, 172}},
	}
	// Five sample offsets per group, orientation-sensitive.
	offsets := [5][2]int{{-12, -12}, {12, -12}, {-12, 12}, {12, 12}, {3, 3}}
	wantSamples := map[string][5][3]byte{
		"---": {{36, 36, 36}, {0, 0, 0}, {255, 255, 36}, {109, 255, 255}, {255, 0, 0}},
		"--r": {{0, 0, 0}, {0, 0, 0}, {109, 109, 36}, {255, 255, 255}, {255, 255, 36}},
		"-y-": {{182, 182, 36}, {255, 109, 0}, {255, 255, 36}, {255, 255, 109}, {36, 73, 146}},
		"-yr": {{109, 109, 36}, {73, 73, 36}, {0, 0, 0}, {255, 109, 73}, {255, 0, 0}},
		"x--": {{36, 36, 36}, {0, 0, 0}, {109, 109, 36}, {255, 255, 36}, {255, 255, 36}},
		"x-r": {{0, 0, 0}, {0, 0, 0}, {36, 109, 146}, {109, 109, 36}, {255, 0, 0}},
		"xy-": {{255, 109, 0}, {182, 219, 146}, {0, 0, 0}, {255, 255, 146}, {255, 0, 0}},
		"xyr": {{255, 73, 0}, {109, 109, 36}, {255, 255, 255}, {109, 109, 36}, {36, 73, 146}},
	}
	for _, g := range bigSpriteGroups {
		count := 0
		var box [4]int
		haveBox := false
		cols := map[[3]byte]bool{}
		for y := g.py - 25; y < g.py+30; y++ {
			for x := g.px - 25; x < g.px+30; x++ {
				if x < 0 || x >= 320 || y < 0 || y >= 256 {
					continue
				}
				px := img.RGBAAt(x, y)
				c := [3]byte{px.R, px.G, px.B}
				if ulaText[c] {
					continue
				}
				count++
				cols[c] = true
				if !haveBox {
					box = [4]int{x, y, x, y}
					haveBox = true
				}
				box[0] = min(box[0], x)
				box[1] = min(box[1], y)
				box[2] = max(box[2], x)
				box[3] = max(box[3], y)
			}
		}
		w := wantStats[g.name]
		if count != w.count || box != w.box || len(cols) != 32 {
			t.Errorf("group %s: %d px %v (%d colours), want %d px %v (32 colours)",
				g.name, count, box, len(cols), w.count, w.box)
		}
		for i, off := range offsets {
			px := img.RGBAAt(g.px+off[0], g.py+off[1])
			if got := [3]byte{px.R, px.G, px.B}; got != wantSamples[g.name][i] {
				t.Errorf("group %s sample %d at (%+d,%+d): got %v, want %v",
					g.name, i, off[0], off[1], got, wantSamples[g.name][i])
			}
		}
	}

	// Invisible ninth big sprite region stays empty (black paper).
	for y := 88; y < 128; y++ {
		for x := 63; x < 105; x++ {
			px := img.RGBAAt(x, y)
			c := [3]byte{px.R, px.G, px.B}
			if !ulaText[c] {
				t.Fatalf("invisible ninth big sprite rendered at (%d,%d): %v", x, y, c)
			}
		}
	}

	// The four border pattern sprites + the solid red square, parked in
	// the left/bottom border (over-border rendering).
	check("red square in bottom-left border", 18, 232, [3]byte{255, 0, 0})
	check("border background", 300, 10, [3]byte{36, 36, 36})
}

// TestNexttestsSpritesScanlineDelay — Sprites/ScanlineDelay: copper-
// raster-timed sprite attribute changes. The fixture (WAIT_H=48) targets
// core 3.0.7+ semantics: an attribute write in the h-blank tail of
// scanline N-1 affects the sprite rendering of scanline N exactly. Four
// rows each pair a static reference sprite (X=152, colour-band pattern:
// cyan/red/yellow/green/violet/white/black rows) with a copper-driven
// effect that must hit ONLY the target scanline (the +0 ruler line,
// where the copper also recolours the ULA paper):
//
//	paper row  8: sprite 1 visible for one line (yellow band shows), cyan paper
//	paper row 24: sprite 2 jumps +9px with ROTATE+MIRRORX (column dots), yellow paper
//	paper row 40: NR$4B moves $1F->$01, the $1F half shows cyan, violet paper
//	paper row 56: sprite palette[$1F] becomes orange for one line, cyan paper
//
// Below, the 4/5-byte attribute records: NextReg-set sprites must show
// "ooo1" (three 1x + one 2xY — the extended bit gates the 5th byte),
// port-set "o1", and the NR$09 lockstep exercise "11" (a port-started
// 5-byte record finished through NR$79 on the tied index). References:
// MAME0.281.jpg + CSpect_sprite_types_OK.png; board photos are the
// older WAIT_H=35 build of the same scene.
func TestNexttestsSpritesScanlineDelay(t *testing.T) {
	h := runNexttestsSNX(t, "SprDelay.snx", 100)
	text := h.ScreenText()
	for _, want := range []string{
		"Visibility:", "RotMir / Xpos:", "Transp. index:", "Palette color:",
		"Setup by NextRegs, check 4B/5B:", `"ooo1"`,
		`Setup by I/O port "o1":`, `Lockstep exercise "11":`,
		"machineID:10", "[SprDelay.snx]",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in screen text", want)
		}
	}
	img := h.ScreenImage()
	check := spriteFrameChecker(t, img)

	paperWhite := [3]byte{182, 182, 182}
	cyanPaper := [3]byte{109, 182, 182}   // %011'101'10
	yellowPaper := [3]byte{219, 219, 182} // %110'110'10
	violetPaper := [3]byte{182, 109, 182} // %101'011'10
	borderCyan := [3]byte{0, 182, 182}
	band := map[string][3]byte{
		"cyan":   {0, 182, 182},
		"red":    {219, 0, 0},
		"yellow": {255, 182, 0},
		"green":  {0, 182, 0},
		"violet": {182, 0, 182},
		"white":  {255, 255, 255},
		"black":  {0, 0, 0},
	}
	trans := [3]byte{0, 255, 255}  // pattern $1F through the identity palette
	orange := [3]byte{255, 146, 0} // %111'100'00

	// Row 1 — visibility: the right sprite (X=161, Y=38) exists for
	// exactly frame row 40 (paper 8 = the +0 ruler line), showing its
	// yellow (+0) band; the ULA paper is light cyan on that row only.
	check("static sprite -2 band", 154, 38, band["cyan"])
	check("static sprite +0 band", 154, 40, band["yellow"])
	check("static sprite +4 band", 154, 44, band["black"])
	check("right sprite hidden above", 164, 39, paperWhite)
	check("right sprite ONE line", 164, 40, band["yellow"])
	check("right sprite hidden below", 164, 41, paperWhite)
	check("cyan paper on target line", 100, 40, cyanPaper)
	check("white paper above", 100, 39, paperWhite)
	check("white paper below", 100, 41, paperWhite)

	// Row 2 — RotMir/Xpos: sprite 2 (X=152, Y=54) jumps to X=161 with
	// ROTATE+MIRRORX for frame row 56 only: rotated, the line shows the
	// pattern COLUMN (dx selects the band row), so x=164 (dx=3) is the
	// green band; the static position shows bright-yellow paper.
	check("rotmir static spot vacated", 154, 56, yellowPaper)
	check("rotmir rotated dot (dx=3 = green)", 164, 56, band["green"])
	check("rotmir dot (dx=1 = red)", 162, 56, band["red"])
	check("rotmir yellow paper", 100, 56, yellowPaper)
	check("rotmir off above", 164, 55, paperWhite)
	check("rotmir off below", 154, 57, band["green"]) // static back: row 57 dy=3

	// Row 3 — transparency index: NR$4B = $01 for frame row 72 only, so
	// sprite 3's $1F right half (x 160..167) shows cyan on that line.
	check("transp right half above", 164, 71, paperWhite)
	check("transp right half ONE line", 164, 72, trans)
	check("transp right half below", 164, 73, paperWhite)
	check("transp violet paper", 100, 72, violetPaper)
	check("transp opaque half intact", 154, 72, band["yellow"])

	// Row 4 — palette colour: NR$4B is $01 for frame rows 83..95 (the
	// $1F half visible as cyan), and palette[$1F] turns orange for frame
	// row 88 only — palette lookups happen at display time, no delay.
	check("pal $1F half cyan above", 164, 87, trans)
	check("pal $1F half ORANGE on target", 164, 88, orange)
	check("pal $1F half cyan below", 164, 89, trans)
	check("pal cyan paper", 100, 88, cyanPaper)

	// 4/5-byte records via NextRegs: "ooo1" at Y=126, X=38/54/70/86.
	for i, x := range []int{40, 56, 72, 88} {
		scaleY := 1
		if i == 3 {
			scaleY = 2 // the genuine 5-byte record
		}
		check(fmt.Sprintf("nextreg sprite %d cyan band", i), x, 126, band["cyan"])
		check(fmt.Sprintf("nextreg sprite %d red band", i), x, 126+scaleY, band["red"])
		check(fmt.Sprintf("nextreg sprite %d green band", i), x, 126+3*scaleY, band["green"])
	}
	// Port-set records "o1" at Y=158: a 4-byte (the 5-byte taint must be
	// cleared by the port write) and a 5-byte 2xY.
	check("port sprite 0 red band (1x)", 40, 159, band["red"])
	check("port sprite 0 green band (1x)", 40, 161, band["green"])
	check("port sprite 1 cyan band (2x)", 56, 159, band["cyan"])
	check("port sprite 1 red band (2x)", 56, 161, band["red"])
	// Lockstep exercise "11" at Y=190: both 2xY — sprite 11's port-started
	// record was finished via NR$79 on the NR$09-tied index.
	check("lockstep sprite 11 cyan (2x)", 40, 191, band["cyan"])
	check("lockstep sprite 11 red (2x)", 40, 193, band["red"])
	check("lockstep sprite 12 cyan (2x)", 56, 191, band["cyan"])
	check("lockstep sprite 12 red (2x)", 56, 193, band["red"])

	// Whole-surface: cyan border everywhere (no phantom sprites — the
	// pre-fix lockstep bug painted a colour-band sprite at frame (0,0)).
	check("top-left corner", 5, 5, borderCyan)
	check("top border", 160, 10, borderCyan)
	check("bottom border", 160, 245, borderCyan)
	check("left border", 10, 128, borderCyan)
	check("right border", 310, 128, borderCyan)
}
