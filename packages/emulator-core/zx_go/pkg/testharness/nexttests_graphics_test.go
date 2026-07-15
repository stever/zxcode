package testharness

// The MrKWatkins/ZXSpectrumNextTests Graphics group (Tests/Graphics/*):
// Layer 2 colour/priority compositing in all six layer orders, the
// legacy port $123B banking windows, Layer 2 hardware scroll + clip,
// the three LayersMixing variants (Timex hi-colour, Timex hi-res and
// LoRes as the ULA-layer mode), the additive blend modes 6/7, and the
// NR$69 display-control shortcut register.
//
// Ground truth: each test's upstream reference captures (MAME 0.282 +
// CSpect + board photos) were eyeballed once against our render, then
// the distinctive per-pixel expectations below were pinned from the
// verified render — the sprites-group method. The Layer2Colours cell
// grid additionally cross-checks the upstream ReadMe's 24-combination
// SLU result table (ss/ll/uu/TT/pp classes land exactly where the
// table says). Colour space is the Next's 9-bit palette projection
// (proj3: 0,36,73,109,146,182,219,255 per channel).
//
// Raster mechanics exercised here: the suite's ScanlinesLoop rewrites
// NR$15 (priority mode + LoRes enable) and the border per 32-line CPU-
// timed raster band — covered by the raster-stamped NR$15 replay — and
// NReg0x69's copper rewrites NR$69 per scanline (Timex mode / shadow
// display / Layer 2 enable at row granularity).

import (
	"image"
	"strings"
	"testing"
)

// Palette-projected colours the mixing tests produce.
var (
	mixL2Green   = [3]byte{0, 219, 0}     // Layer 2 green $18
	mixPrioGreen = [3]byte{0, 255, 0}     // priority-bit green $1C (9-bit via NR$44)
	mixULACyan   = [3]byte{0, 219, 255}   // ULA/HiCol/LoRes bright cyan strip
	mixSprYellow = [3]byte{219, 219, 0}   // sprite pattern yellow $D8
	mixFallback  = [3]byte{255, 0, 255}   // NR$4A pink $E3 (all layers transparent)
	mixWhite     = [3]byte{182, 182, 182} // C_WHITE $B6
	mixWhite2    = [3]byte{146, 146, 182} // C_WHITE2 $92 (dark-white raster bands)
)

// mixCellExpect is the shared 6-band × 4-row × 6-col verdict grid of the
// LayersMixing family (Layer2Colours and the HiCol/LoRes/HiRes variants
// draw identical layer-state matrices; only the ULA mode differs — the
// sampled cells hit positions where the class result coincides). Bands
// top-to-bottom = the raster-timed NR$15 orders SLU/LSU/SUL/LUS/USL/ULS.
// The grid encodes the ordering semantics: e.g. band 1 (LSU) r0 c1 is
// L2-green where band 0 (SLU) shows the sprite; bands 4/5 (USL/ULS)
// differ exactly in r1 c1 (sprite-over-L2 vs L2-over-sprite); the
// priority-bit columns (c4/c5 — and c3 where the sprite is absent) stay
// promoted green in every order; r3 shows the NR$4A fallback wherever
// every layer is transparent, with the sprite still covering c1/c3.
var mixCellExpect = func() [6][4][6][3]byte {
	gl, gp, cy, ys, pk := mixL2Green, mixPrioGreen, mixULACyan, mixSprYellow, mixFallback
	return [6][4][6][3]byte{
		{ // SLU
			{gl, ys, gl, ys, gp, gp},
			{gl, ys, gl, ys, gp, gp},
			{cy, ys, cy, ys, cy, cy},
			{pk, ys, pk, ys, pk, pk},
		},
		{ // LSU
			{gl, gl, gl, gp, gp, gp},
			{gl, gl, gl, gp, gp, gp},
			{cy, ys, cy, ys, cy, cy},
			{pk, ys, pk, ys, pk, pk},
		},
		{ // SUL
			{cy, ys, cy, ys, gp, gp},
			{gl, ys, gl, ys, gp, gp},
			{cy, ys, cy, ys, cy, cy},
			{pk, ys, pk, ys, pk, pk},
		},
		{ // LUS
			{gl, gl, gl, gp, gp, gp},
			{gl, gl, gl, gp, gp, gp},
			{cy, cy, cy, cy, cy, cy},
			{pk, ys, pk, ys, pk, pk},
		},
		{ // USL
			{cy, cy, cy, gp, gp, gp},
			{gl, ys, gl, gp, gp, gp},
			{cy, cy, cy, cy, cy, cy},
			{pk, ys, pk, ys, pk, pk},
		},
		{ // ULS
			{cy, cy, cy, gp, gp, gp},
			{gl, gl, gl, gp, gp, gp},
			{cy, cy, cy, cy, cy, cy},
			{pk, ys, pk, ys, pk, pk},
		},
	}
}()

// assertMixCellGrid checks the shared verdict grid. at maps a paper-space
// coordinate to the image pixel (the HiRes frame doubles X).
func assertMixCellGrid(t *testing.T, img *image.RGBA, at func(px, py int) (int, int)) {
	t.Helper()
	for band := 0; band < 6; band++ {
		for r := 0; r < 4; r++ {
			for c := 0; c < 6; c++ {
				want := mixCellExpect[band][r][c]
				x, y := at(40+c*8+4, band*32+r*8+4)
				if got := imgRGB(img, x, y); got != want {
					t.Errorf("band %d cell (%d,%d) at img(%d,%d) = %v, want %v",
						band, c, r, x, y, got, want)
				}
			}
		}
	}
}

// assertMixBandedBorder checks the CPU-raster-timed border bands the
// ScanlinesLoop writes (C_WHITE for SLU/SUL/USL + top/bottom, C_WHITE2
// for LSU/LUS/ULS) on a 320x256 sprite-frame image, sampling the left
// and right border columns of every band.
func assertMixBandedBorder(t *testing.T, img *image.RGBA) {
	t.Helper()
	for band := 0; band < 6; band++ {
		want := mixWhite
		if band%2 == 1 {
			want = mixWhite2
		}
		// Mid-band row: paper band*32+16 = image row 32+band*32+16.
		y := 32 + band*32 + 16
		for _, x := range []int{2, 317} {
			if got := imgRGB(img, x, y); got != want {
				t.Errorf("band %d border at (%d,%d) = %v, want %v", band, x, y, got, want)
			}
		}
	}
	// Top and bottom over-border strips are C_WHITE (BORDER CI_WHITE
	// before/after the six phases).
	for _, y := range []int{4, 250} {
		if got := imgRGB(img, 160, y); got != mixWhite {
			t.Errorf("over-border strip at (160,%d) = %v, want white", y, got)
		}
	}
}

// TestNexttestsGraphicsLayer2Colours — Graphics/Layer2Colours: all 24
// sprite/Layer2/ULA state combinations in all six NR$15 orders, with
// the two priority-bit Layer 2 palette entries (NR$44 9-bit writes) and
// the pink transparency fallback. Also regression-guards the port
// $123B shadow-PAGING bit: the test ends with a shadow-over-ROM write
// that must NOT flip the ULA onto the shadow display (the scene went
// black when it did).
func TestNexttestsGraphicsLayer2Colours(t *testing.T) {
	h := runNexttestsSNX(t, "L2Colour.snx", 200)
	img := h.ScreenImage()
	if img.Rect.Dx() != 320 || img.Rect.Dy() != 256 {
		t.Fatalf("frame = %dx%d, want 320x256 (sprites active)", img.Rect.Dx(), img.Rect.Dy())
	}
	assertMixCellGrid(t, img, func(px, py int) (int, int) { return 32 + px, 32 + py })
	assertMixBandedBorder(t, img)
	// The ULA background outside the drawn areas is white paper — the
	// shadow-display regression showed black here.
	if got := imgRGB(img, 32+110, 32+8); got != mixWhite {
		t.Errorf("ULA paper background = %v, want white (shadow-display regression)", got)
	}
}

// TestNexttestsGraphicsLayersMixingHiCol — Graphics/LayersMixingHiCol:
// the same matrix with the ULA layer in Timex HI-COLOUR mode (8x1
// attributes fetched through the pixel address layout with vram_a bit
// 13 = 1, zxula.vhd:238-239). The machineID banner row is the
// mode-specific witness: it renders black-background text via per-
// pixel-row attributes, where the classic test shows white ULA paper.
func TestNexttestsGraphicsLayersMixingHiCol(t *testing.T) {
	h := runNexttestsSNX(t, "LmxHiCol.snx", 200)
	img := h.ScreenImage()
	assertMixCellGrid(t, img, func(px, py int) (int, int) { return 32 + px, 32 + py })
	assertMixBandedBorder(t, img)
	// Hi-colour witness: the banner band (paper rows 8-15 at x=200) is
	// black in every one of its 8 pixel rows — only per-8x1 attributes
	// can paint that under a white-paper classic attr map.
	for y := 8; y < 16; y++ {
		if got := imgRGB(img, 32+200, 32+y); got != [3]byte{0, 0, 0} {
			t.Errorf("hi-colour banner row %d = %v, want black", y, got)
		}
	}
}

// TestNexttestsGraphicsLayersMixingLoRes — Graphics/LayersMixingLoRes:
// the same matrix with the ULA layer in LORES mode (NR$15 bit 7,
// pkg/next/lores — 128x96 doubled, full 8-bit palette indices). The
// mode-specific witness: the machineID/Legend texts here are drawn in
// LAYER 2 (LoRes is too coarse for text) in the C_TEXT colour over the
// white LoRes background — both only render if the LoRes layer is the
// ULA content AND Layer 2 composites over it.
func TestNexttestsGraphicsLayersMixingLoRes(t *testing.T) {
	h := runNexttestsSNX(t, "LmixLoRs.snx", 200)
	img := h.ScreenImage()
	assertMixCellGrid(t, img, func(px, py int) (int, int) { return 32 + px, 32 + py })
	assertMixBandedBorder(t, img)
	// C_TEXT ($F3 → 255,146,255) glyph pixels of the L2-drawn header
	// texts over the LoRes white background.
	textPixels := 0
	whitePixels := 0
	for y := 8; y < 24; y++ {
		for x := 140; x < 240; x++ {
			switch imgRGB(img, 32+x, 32+y) {
			case [3]byte{255, 146, 255}:
				textPixels++
			case mixWhite:
				whitePixels++
			}
		}
	}
	if textPixels < 100 {
		t.Errorf("L2 header text pixels = %d, want >= 100 (LoRes white + L2 text)", textPixels)
	}
	if whitePixels < 800 {
		t.Errorf("LoRes white background pixels = %d, want >= 800", whitePixels)
	}
}

// TestNexttestsGraphicsLayersMixingHiRes — Graphics/LayersMixingHiRes:
// the same matrix with the ULA layer in Timex HI-RES 512x192 mode,
// composited at native half-pixel granularity (ComposeHiResScanline —
// a Layer 2/sprite pixel covers two ULA half-pixels). Frame is
// 640x240. Witnesses: the border takes the SYNTHESIZED hi-res paper
// entry 128+NOT(colour) = index 130 (the core-2.00.25+ behaviour the
// upstream ReadMe documents — C_WHITE2's colour, NOT the port $FE
// border, so the raster border bands of the other variants must NOT
// appear); and the legend checker rows carry sub-pixel detail.
func TestNexttestsGraphicsLayersMixingHiRes(t *testing.T) {
	h := runNexttestsSNX(t, "LmxHiRes.snx", 200)
	img := h.ScreenImage()
	if img.Rect.Dx() != 640 || img.Rect.Dy() != 256 {
		t.Fatalf("frame = %dx%d, want 640x256 (hi-res wide)", img.Rect.Dx(), img.Rect.Dy())
	}
	assertMixCellGrid(t, img, func(px, py int) (int, int) { return 64 + 2*px, 32 + py })
	// Hi-res border: uniform index-130 colour on all four sides, every
	// band (port $FE writes are inert in hi-res, zxula.vhd:425-427).
	for _, p := range [][2]int{{5, 5}, {5, 120}, {5, 235}, {634, 5}, {634, 120}, {634, 235}, {320, 5}, {320, 235}} {
		if got := imgRGB(img, p[0], p[1]); got != mixWhite2 {
			t.Errorf("hi-res border at (%d,%d) = %v, want %v (entry 130)", p[0], p[1], got, mixWhite2)
		}
	}
	// Sub-pixel detail: the ULA legend box's chequered rows change
	// colour many times across a 96-half-pixel span — a doubled 320
	// render cannot produce this many transitions at this position.
	transitions := 0
	prev := imgRGB(img, 64+2*184, 32+156)
	for i := 1; i < 96; i++ {
		cur := imgRGB(img, 64+2*184+i, 32+156)
		if cur != prev {
			transitions++
			prev = cur
		}
	}
	if transitions < 20 {
		t.Errorf("hi-res checker transitions = %d, want >= 20 (half-pixel render)", transitions)
	}
}

// TestNexttestsGraphicsLightenDarken — Graphics/LightenDarken_L2_ULA:
// the ADDITIVE blend modes — NR$15 mode 6 (clamped L+U) on the top
// band and mode 7 (L+U-5) on the bottom band, LoRes as the ULA layer,
// verified via the gradient-strip arithmetic. The sampled cells pin
// the per-channel sums/differences (e.g. L2 green + ULA grey →
// (3,6,3); the L+U-5 band clamps to (0,1,0)); the fallback-pink cells
// pin the blend rule that a transparent Layer 2 pixel shows the
// NR$4A fallback, never the bare ULA (upstream table `sTlTuu → TT`).
func TestNexttestsGraphicsLightenDarken(t *testing.T) {
	h := runNexttestsSNX(t, "Lmix_LxU.snx", 200)
	img := h.ScreenImage()
	for _, p := range []struct {
		x, y int
		want [3]byte
	}{
		// L+U band (mode 6).
		{124, 92, [3]byte{109, 219, 109}},
		{132, 92, [3]byte{109, 219, 109}},
		{124, 100, [3]byte{109, 109, 0}},
		{132, 100, [3]byte{109, 109, 0}},
		// L+U-5 band (mode 7): darker clamped results.
		{124, 132, [3]byte{0, 36, 0}},
		{132, 132, [3]byte{0, 36, 0}},
		{124, 140, [3]byte{109, 109, 0}},
		// Transparent Layer 2 → bright-pink fallback (never bare ULA).
		{124, 148, [3]byte{255, 0, 255}},
		{132, 148, [3]byte{255, 0, 255}},
	} {
		if got := imgRGB(img, p.x, p.y); got != p.want {
			t.Errorf("blend pixel (%d,%d) = %v, want %v", p.x, p.y, got, p.want)
		}
	}
	// Whole-surface: the border is C_WHITE above/below with the test's
	// raster-timed T_WHITE ($6D → 109,109,109) band across the mixing
	// rows.
	for _, p := range [][2]int{{2, 4}, {2, 250}, {160, 4}, {160, 250}} {
		if got := imgRGB(img, p[0], p[1]); got != mixWhite {
			t.Errorf("border at (%d,%d) = %v, want white", p[0], p[1], got)
		}
	}
	for _, p := range [][2]int{{2, 128}, {317, 128}} {
		if got := imgRGB(img, p[0], p[1]); got != [3]byte{109, 109, 109} {
			t.Errorf("border band at (%d,%d) = %v, want T_WHITE grey", p[0], p[1], got)
		}
	}
}

// TestNexttestsGraphicsLayer2Port — Graphics/Layer2Port: the legacy
// port $123B write/read-over-ROM windows for both the visible (NR$12)
// and shadow (NR$13) banks, the IM1-in-Layer2 interrupt case, and the
// core-3.0.7+ bank-offset form (bit 4). Self-verdicting: every test
// paints a green (never red) block, and the border goes green on full
// pass. The screen text is the label sheet.
func TestNexttestsGraphicsLayer2Port(t *testing.T) {
	h := runNexttestsSNX(t, "L2Port.snx", 200)
	const green = 4
	if got := h.ULA().BorderColour; got != green {
		t.Errorf("border = %d, want %d (green = all port tests passed)", got, green)
	}
	text := h.ScreenText()
	for _, want := range []string{"Visible Layer 2", "Shadow Layer 2", "Bank offset", "r+w-over-ROM"} {
		if !strings.Contains(text, want) {
			t.Errorf("screen text missing %q:\n%s", want, text)
		}
	}
	// Verdict surface: green blocks present in both shades (the paler
	// checker rows of the offset dots), and NOT ONE red failure pixel
	// anywhere on the paper.
	img := h.ScreenImage()
	bright, pale, red := 0, 0, 0
	for y := 0; y < 192; y++ {
		for x := 0; x < 256; x++ {
			switch imgRGB(img, 32+x, 32+y) {
			case [3]byte{0, 255, 0}:
				bright++
			case [3]byte{0, 219, 0}:
				pale++
			case [3]byte{255, 0, 0}, [3]byte{219, 0, 0}:
				red++
			}
		}
	}
	if red != 0 {
		t.Errorf("%d red failure pixels on the verdict surface", red)
	}
	if bright < 1000 || pale < 1000 {
		t.Errorf("green verdict pixels = %d bright / %d pale, want >= 1000 each", bright, pale)
	}
}

// TestNexttestsGraphicsLayer2Scroll — Graphics/Layer2Scroll: the NR$16
// (9-bit X via the port write path) / NR$17 hardware scroll animated to
// [196,133] plus the NR$18 Layer 2 clip and NR$1A ULA clip at
// [8,239]x[8,175]. The scene's own read-back sheet shows the final
// registers ($71 probe: NR$16 low byte $C4 = 196, NR$17 $85 = 133);
// the geometric assertion is the ReadMe's "lines connect": each
// 8px-ruler ULA tick column has its Layer 2 dot exactly one pixel to
// its left — only true when the L2 scroll landed at [196,133].
func TestNexttestsGraphicsLayer2Scroll(t *testing.T) {
	h := runNexttestsSNX(t, "L2Scroll.snx", 400)
	const green = 4
	if got := h.ULA().BorderColour; got != green {
		t.Errorf("border = %d, want %d (green = auto-scroll finished)", got, green)
	}
	text := h.ScreenText()
	if !strings.Contains(text, "0C4") || !strings.Contains(text, "85") {
		t.Errorf("scroll read-back sheet missing 0C4/85:\n%s", text)
	}
	img := h.ScreenImage()
	// Ruler alignment at image row 84 (paper y 60): ULA blue tick at
	// image x = 72+8k, L2 light-blue dot at x-1.
	for _, x := range []int{72, 80, 88, 96, 104} {
		if got := imgRGB(img, x, 84); got != [3]byte{0, 0, 182} {
			t.Errorf("ULA ruler tick at (%d,84) = %v, want ULA blue", x, got)
		}
		if got := imgRGB(img, x-1, 84); got != [3]byte{146, 146, 255} {
			t.Errorf("L2 ruler dot at (%d,84) = %v, want L2 light blue", x-1, got)
		}
	}
	// ULA clip margins ([8,239]x[8,175]): the excluded frame shows the
	// NR$4A fallback (set green by the test) — Layer 2 is clipped there
	// too, so nothing else may paint it.
	for _, p := range [][2]int{{32 + 2, 24 + 100}, {32 + 253, 24 + 100}, {32 + 128, 24 + 2}, {32 + 128, 24 + 189}} {
		if got := imgRGB(img, p[0], p[1]); got != [3]byte{0, 182, 0} {
			t.Errorf("clip margin at (%d,%d) = %v, want fallback green", p[0], p[1], got)
		}
	}
	// Inside the window the ULA paper is white.
	if got := imgRGB(img, 32+128, 24+60); got != mixWhite {
		t.Errorf("paper inside clip = %v, want white", got)
	}
}

// TestNexttestsGraphicsNextReg0x69 — Graphics/NextReg0x69: NR$69 as
// the composed alias of port $123B bit 1 / port $7FFD bit 3 / port
// $FF (zxnext.vhd:6096 read, :3924/:3658/:3617 write fan-out), plus
// NR$08 bit 2 gating the port $FF read. The CPU phase self-reports
// "Tests OK: 10/10"; the copper phase then switches NR$69 at scanline
// granularity, band by band — Layer 2 / shadow ULA / Timex screen 1 /
// hi-colour / two hi-res rows / both combined rows — each painting a
// green cell from its own mode's memory. NR$12 is poked to 9 after
// load: the test assumes the NextZXOS launch state (banks 9-11 hold
// its Layer 2 rows), like the OS the upstream captures ran under.
func TestNexttestsGraphicsNextReg0x69(t *testing.T) {
	h := runNexttestsSNX(t, "NReg0x69.snx", 0)
	h.ula.WritePort(0x243B, 0x12)
	h.ula.WritePort(0x253B, 9)
	h.RunFrames(400)

	text := h.ScreenText()
	if !strings.Contains(text, "Tests OK: 10/10") {
		t.Errorf("register alias tests not 10/10:\n%s", text)
	}
	const green = 4
	if got := h.ULA().BorderColour; got != green {
		t.Errorf("border = %d, want %d (green = pass)", got, green)
	}
	img := h.ScreenImage()
	countIn := func(y int, want [3]byte) int {
		n := 0
		for x := 132; x < 252; x++ {
			if imgRGB(img, x, y) == want {
				n++
			}
		}
		return n
	}
	// Per-band verdict rows (image rows on the 320×256 wide frame,
	// paper at row 32; each band is one 8px char row displaying a
	// different NR$69-selected source):
	//   60  Layer 2 band       — L2 green cell
	//   68  ULA shadow band    — bank-7 screen's green cell
	//   76  Timex screen 1     — dfile-2 green cell
	//   84  Timex hi-colour    — 8x1-attr green cell
	//   92  hi-res black/white — white text band
	//  100  hi-res blue/yellow — yellow band
	//  108  L2 + shadow        — BOTH green cells
	//  116  L2 + Timex scr1    — BOTH green cells
	if n := countIn(60, [3]byte{0, 255, 0}); n < 12 {
		t.Errorf("Layer 2 band green pixels = %d, want >= 12", n)
	}
	for _, y := range []int{68, 76, 84} {
		if n := countIn(y, [3]byte{0, 182, 0}); n < 12 {
			t.Errorf("band at row %d green pixels = %d, want >= 12", y, n)
		}
	}
	for x := 132; x < 252; x++ {
		if got := imgRGB(img, x, 92); got != [3]byte{255, 255, 255} {
			t.Errorf("hi-res b/w band at (%d,92) = %v, want white", x, got)
			break
		}
	}
	for x := 132; x < 252; x++ {
		if got := imgRGB(img, x, 100); got != [3]byte{255, 255, 0} {
			t.Errorf("hi-res blue/yellow band at (%d,100) = %v, want yellow", x, got)
			break
		}
	}
	for _, y := range []int{108, 116} {
		if a, b := countIn(y, [3]byte{0, 255, 0}), countIn(y, [3]byte{0, 182, 0}); a < 12 || b < 12 {
			t.Errorf("combined band row %d greens = %d L2 / %d ULA, want >= 12 each", y, a, b)
		}
	}
}
