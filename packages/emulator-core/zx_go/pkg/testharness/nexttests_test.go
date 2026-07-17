package testharness

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/install/installtest"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// These tests run the vendored classic-machine (.sna) test programs from
// MrKWatkins/ZXSpectrumNextTests (MIT; provenance and licence in
// testdata/nexttests/). Each program self-reports on the Spectrum screen;
// assertions OCR the screen (ScreenText) and pin the verdicts to the
// suite's real-hardware reference photographs.
//
// Where the program exposes a behaviour zx_go knowingly lacks, the test
// SKIPS with the gap reference instead of failing, so the suite stays
// green while the conformance dashboard shows the row as a documented
// gap (docs/architecture/known-gaps.md). If the gap gets fixed the skip
// turns into a hard assertion failure-on-regression by flipping the
// branch below.

func runNexttestsSNA(t *testing.T, name string, frames int) *Harness {
	t.Helper()
	h, err := New(roms.Model48K)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.CloseFiles)
	// The block-flags test probes the Kempston port ($1F) expecting
	// bit 7 low; without the interface the floating bus answers.
	h.ULA().KempstonEnabled = true
	if err := h.LoadSnapshot(filepath.Join("testdata", "nexttests", name)); err != nil {
		t.Fatal(err)
	}
	h.RunFrames(frames)
	return h
}

func screenLine(text, marker string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, marker) {
			return line
		}
	}
	return ""
}

// TestNexttestsZ80BlockFlags — flags of IM2-interrupted repeating block
// instructions (LDxR/CPxR/INxR/OTxR), per David Banks's research. The
// program prints expected=measured pairs; on real hardware
// (z80_block_flags_test_v5_shrek_zx128.jpg) every pair matches, giving
// four '=' per result row.
func TestNexttestsZ80BlockFlags(t *testing.T) {
	h := runNexttestsSNA(t, "z80bltst.sna", 400)
	text := h.ScreenText()
	rows := 0
	mismatched := 0
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, " F: ") {
			continue
		}
		rows++
		if strings.Count(line, "=") != 4 {
			mismatched++
		}
	}
	if rows < 15 {
		t.Fatalf("expected at least 15 result rows, OCR found %d:\n%s", rows, text)
	}
	if mismatched > 0 {
		t.Fatalf("interrupted-block-instruction flags diverge from real hardware "+
			"in %d of %d rows (blockRepeatFlags regression):\n%s", mismatched, rows, text)
	}
}

// TestNexttestsZ80IntSkipBasics — the parts of the interrupt-acceptance
// test zx_go must get right today: NOP blocks accept ~one interrupt per
// frame, DI inhibits completely, SCF/CCF chains behave, and LD A,I / LD
// A,R read IFF2 as one during the interrupt window.
func TestNexttestsZ80IntSkipBasics(t *testing.T) {
	h := runNexttestsSNA(t, "int_skip.sna", 400)
	text := h.ScreenText()
	if line := screenLine(text, "NOP"); !strings.Contains(line, "5") {
		t.Errorf("NOP benchmark row missing or implausible: %q", line)
	}
	if line := screenLine(text, "DI "); !strings.Contains(line, "|   0 |OK") {
		t.Errorf("DI row should count 0 with OK verdict: %q", line)
	}
	if line := screenLine(text, "SCF+CCF"); !strings.Contains(line, "OK") {
		t.Errorf("SCF+CCF row should be OK: %q", line)
	}
	for _, want := range []string{"LD A,I IFF2 reading: correct", "LD A,R IFF2 reading: correct"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q", want)
		}
	}
	if t.Failed() {
		t.Logf("screen text:\n%s", text)
	}
}

// TestNexttestsZ80IntSkipInhibition — interrupt acceptance must be
// inhibited after DD/FD prefix bytes and across EI chains (a narrow
// /INT pulse expiring inside the block is missed, never delivered
// late), and the level-triggered pulse must re-enter the ISR at least
// twice per signal. Implemented via the classic narrow-pulse frame INT
// (frameIntPulse); hard regression guard.
func TestNexttestsZ80IntSkipInhibition(t *testing.T) {
	h := runNexttestsSNA(t, "int_skip.sna", 400)
	text := h.ScreenText()
	var errs []string
	for _, block := range []string{"DD ", "FD ", "DDFD", "EI "} {
		if line := screenLine(text, block); strings.Contains(line, "ERR") {
			errs = append(errs, fmt.Sprintf("%s block allows ISR", strings.TrimSpace(block)))
		}
	}
	if line := screenLine(text, "ISR entries"); strings.Contains(line, ": 1") || strings.Contains(line, ":  1") {
		errs = append(errs, "only 1 ISR entry per /INT signal (hardware: 2+ while the pulse holds)")
	}
	if len(errs) > 0 {
		t.Fatalf("interrupt-window regression: %s\nscreen:\n%s", strings.Join(errs, "; "), text)
	}
}

// TestNexttestsCcfScfStability — SCF/CCF outcomes must be deterministic
// frame over frame (a random-flags CPU shows an error square and drops
// the "No error" report).
func TestNexttestsCcfScfStability(t *testing.T) {
	h := runNexttestsSNA(t, "ccffrm.sna", 400)
	if text := h.ScreenText(); !strings.Contains(text, "No error") {
		t.Fatalf("expected the 'No error' verdict:\n%s", text)
	}
}

// TestNexttestsDIHalt — HALT with interrupts disabled must hang forever:
// the program sets the border green, executes DI + HALT, and would set
// the border red if execution ever continued.
func TestNexttestsDIHalt(t *testing.T) {
	h := runNexttestsSNA(t, "DIHalt.sna", 400)
	const green = 4
	if got := h.ULA().BorderColour; got != green {
		t.Fatalf("border = %d, want %d (green): DI+HALT must never resume", got, green)
	}
	h.RunFrames(200)
	if got := h.ULA().BorderColour; got != green {
		t.Fatalf("border = %d after further frames, want %d (green)", got, green)
	}
}

// runNexttestsSNX loads one of the suite's Next-side .snx snapshots
// (a standard 48K SNA whose extension signals "run on a Next") onto
// the harness Next machine.
func runNexttestsSNX(t *testing.T, name string, frames int) *Harness {
	t.Helper()
	installtest.RedirectConfig(t)
	installFakeDistroForLoad(t)
	h, err := New(roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.CloseFiles)
	if err := h.LoadSnapshot(filepath.Join("testdata", "nexttests", name)); err != nil {
		t.Fatal(err)
	}
	h.RunFrames(frames)
	return h
}

// driveZ80NSuite runs one of the interactive Z80N instruction testers:
// key 2 enables the 28 MHz turbo (exercising NR$07 en route), key 5
// starts the run. Every instruction row must end OK and the border
// must go green; a red border or an ERR row is a real instruction bug
// (this caught LDDX/LDDRX direction and LDWS flags on first run).
func driveZ80NSuite(t *testing.T, snx string, rows int) {
	t.Helper()
	h := runNexttestsSNX(t, snx, 60)
	h.kbd.PressMatrixKey(3, 0x02, true) // 2 = 28 MHz turbo
	h.RunFrames(10)
	h.kbd.PressMatrixKey(3, 0x02, false)
	h.RunFrames(5)
	h.kbd.PressMatrixKey(3, 0x10, true) // 5 = Go
	h.RunFrames(10)
	h.kbd.PressMatrixKey(3, 0x10, false)
	h.RunFrames(1500)
	text := h.ScreenText()
	okRows := 0
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimRight(line, " ")
		if strings.HasSuffix(trimmed, "OK") || strings.HasSuffix(trimmed, "OK1") {
			okRows++
		}
		if strings.Contains(line, "ERR") {
			t.Errorf("instruction failed: %q", strings.TrimSpace(line))
		}
	}
	if okRows < rows {
		t.Errorf("only %d of %d instruction rows report OK:\n%s", okRows, rows, text)
	}
	const green = 4
	if got := h.ULA().BorderColour; got != green {
		t.Errorf("border = %d, want %d (green = suite pass signal)", got, green)
	}
}

// TestNexttestsZ80N — the suite's Z80N instruction tester: all 23
// extended instructions across their operand ranges, verdicts pinned
// to the real-hardware reference photo (release/!Z80N.jpg upstream).
func TestNexttestsZ80N(t *testing.T) {
	driveZ80NSuite(t, "Z80N.snx", 23)
}

// TestNexttestsZ80Nc2 — the core-2 additions: the barrel shifts
// (BRLC/BSLA/BSRA/BSRF/BSRL) and JP (C).
func TestNexttestsZ80Nc2(t *testing.T) {
	driveZ80NSuite(t, "Z80Nc2.snx", 6)
}

// --- base/Copper: raster-timed palette rewrites -------------------------
//
// Copper.snx enables ULANext (ink mask 7), uploads ~1011 copper
// instructions that redraw PAPER/BORDER 7 per half-pixel — five Swedish
// flags, a horizontal-wait probe and a Z80-animated full-width line —
// and self-reports the instruction count both as uploaded (counted in
// IY) and as read back from NR$61/$62. Ground truth: the core 3.01.5
// board photo and the MAME 0.282 capture both show 03F3/03F3 and the
// same scene (Tests/base/Copper/*.jpg upstream); positions follow the
// core-3.0 28MHz copper (release/!Copper.txt EDIT: flag pixels are
// half-width and positions shift ~1px vs the old 14MHz description).

// Colours the test produces, as 9-bit palette entries through the
// live-palette ULA render: C_WHITE=$B6, C_BLUE=$0E, C_YELLOW=$F8 and
// black ink 0 (Main.asm's constants; low blue bit = OR of the two
// 8-bit blue bits).
var (
	copperWhite  = [3]byte{182, 182, 182}
	copperBlue   = [3]byte{0, 109, 182}
	copperYellow = [3]byte{255, 219, 0}
	copperBlack  = [3]byte{0, 0, 0}
)

// copperFlagRows builds the 16-half-pixel Swedish flag rows as rendered
// at the 28MHz copper's 2-cycles-per-MOVE pacing: 8 full pixels wide,
// with the vertical yellow stripe (FlagData half-pixels 5-6) landing on
// pixel column `yellowCol` — the visible column depends on the flag's
// x mod 8 NOOP-padding phase (2 NOOPs = half a pixel), so flags at odd
// sub-columns sample halves 1,3,5,... (stripe on column 2) and the rest
// sample halves 0,2,4,... (stripe on column 3). B=blue Y=yellow.
func copperFlagRows(yellowCol int) [10]string {
	edge := []byte("BBBBBBBB")
	edge[yellowCol] = 'Y'
	stripe := string(edge)
	return [10]string{
		stripe, stripe, stripe, stripe,
		"YYYYYYYY", "YYYYYYYY",
		stripe, stripe, stripe, stripe,
	}
}

// TestNexttestsCopper runs base/Copper and asserts the full visible
// surface: the two self-reported counters, all five flags (including
// the over-left-border one), the horizontal-wait greater/equal probe's
// single yellow pixel, the Z80-animated full-width line (with its left
// border segment one row lower), the ruler dots and the restored-white
// background.
//
// Documented residual precision: the render samples the palette once
// per 7MHz pixel (state 2 copper cycles into the pixel), so the flags'
// half-pixel internal detail collapses to one colour per pixel. The
// half-pixel phase our sampling picks is not resolvable from the
// upstream photos; everything at pixel granularity and above is
// asserted here.
func TestNexttestsCopper(t *testing.T) {
	h := runNexttestsSNX(t, "Copper.snx", 200)

	// Self-reported instruction counters (board + MAME: 03F3 both).
	text := h.ScreenText()
	if line := screenLine(text, "Copper ins."); !strings.Contains(line, "03F3") {
		t.Errorf("uploaded-count line = %q, want 03F3", line)
	}
	if line := screenLine(text, "Read back"); !strings.Contains(line, "03F3") {
		t.Errorf("read-back line = %q, want 03F3 (NR$61/$62 byte cursor /2)", line)
	}

	img := h.ScreenImage()
	at := func(sx, sy int) [3]byte {
		return frameRGB(img, 32+sx, 32+sy)
	}
	check := func(what string, sx, sy int, want [3]byte) {
		if got := at(sx, sy); got != want {
			t.Errorf("%s at (%d,%d): got %v, want %v", what, sx, sy, got, want)
		}
	}
	checkFlag := func(name string, x0, y0, yellowCol int) {
		for r, row := range copperFlagRows(yellowCol) {
			for c := 0; c < 8; c++ {
				want := copperBlue
				if row[c] == 'Y' {
					want = copperYellow
				}
				check(name, x0+c, y0+r, want)
			}
		}
		// The flag ends after 8 pixels; the restore MOVE brings white back.
		check(name+" right restore", x0+8, y0, copperWhite)
	}

	// The five flags. Positions are the 28MHz-copper landing pixels:
	// an (x mod 8) sub-column offset of 1-2 costs 2(x mod 8) NOOP
	// cycles = half a pixel each, so [1,64] keeps x=1 while [66,77]
	// and [242,118] land one pixel after their 8-aligned column, and
	// [248,91] (offset 0) lands exactly at 248 — consistent with the
	// !Copper.txt EDIT that core-3.0 positions shift vs the 14MHz
	// description. The over-left-border flag (WAIT column 52 =
	// hcount 428, the previous line's tail) renders in the left
	// border one row below its nominal y, like the animated line's
	// border segment.
	checkFlag("flag[1,64]", 1, 64, 2)
	checkFlag("flag[66,77]", 65, 77, 3)
	checkFlag("flag[248,91]", 248, 91, 3)
	checkFlag("flag[left-border,104]", -32, 105, 3)
	checkFlag("flag[242,118]", 241, 118, 3)

	// Ruler dots (INK 0 through ULANext ink mask 7 = palette entry 0):
	// row 63 at x=0,4,8,... and row 128 at x=...,236,240,244,248,252.
	for _, x := range []int{0, 4, 8, 12} {
		check("ruler row 63", x, 63, copperBlack)
	}
	for _, x := range []int{236, 240, 244, 252} {
		check("ruler row 128", x, 128, copperBlack)
	}

	// Horizontal-wait greater/equal probe (y=140): blue x=128..191,
	// ONE yellow pixel at 192 (the h=0 WAIT releases instantly), then
	// white — if the h=0 WAIT rolled over to the next frame the whole
	// row would stay blue/yellow.
	check("y140 pre-line white", 127, 140, copperWhite)
	for _, x := range []int{128, 150, 191} {
		check("y140 blue", x, 140, copperBlue)
	}
	check("y140 yellow pixel", 192, 140, copperYellow)
	check("y140 post-yellow white", 193, 140, copperWhite)
	check("y139 untouched", 150, 139, copperWhite)
	check("y141 untouched", 150, 141, copperWhite)

	// Z80-animated line: exactly one row in 144..159 is blue across
	// the paper and right border, with its left-border segment one
	// row lower (the border pixels at the line start belong to the
	// previous raster line's tail — !Copper.txt).
	blueRow := -1
	for y := 144; y < 160; y++ {
		if at(0, y) == copperBlue && at(255, y) == copperBlue {
			if blueRow != -1 {
				t.Errorf("animated line: rows %d and %d both blue, want exactly one", blueRow, y)
			}
			blueRow = y
		}
	}
	if blueRow == -1 {
		t.Fatalf("animated line: no blue row in 144..159")
	}
	check("animated line right border", 280, blueRow, copperBlue)
	check("animated line left border, one row lower", -20, blueRow+1, copperBlue)
	check("animated line left border not on its own row", -20, blueRow, copperWhite)

	// Background/border restored white everywhere the program isn't
	// drawing (PAPER 7 = C_WHITE $B6 → (182,182,182) via the 9-bit
	// palette — the FPGA feeds every ULA/border pixel through the
	// palette SRAM).
	check("paper background", 200, 40, copperWhite)
	check("left border", -20, 40, copperWhite)
	check("right border", 280, 96, copperWhite)

	// Border uniformity: the rows ABOVE and BELOW the paper resolve
	// through the same palette SRAM as everything else — one palette,
	// one DAC, so their white is the identical 9-bit projection, not
	// the classic-renderer value. (A mismatch here is exactly the
	// banded-border regression the live-palette render shipped with.)
	check("top border", 100, -10, copperWhite)
	check("top border first row", 100, -32, copperWhite)
	check("bottom border", 100, 200, copperWhite)
	check("bottom border last row", 100, 223, copperWhite)
}

// --- base/DMA: zxnDMA transfer-mode matrix ------------------------------

// TestNexttestsDMA runs base/DMA and asserts its full verdict surface.
// The program drives 12 A->B and 12 B->A four-byte transfers through
// every source/destination address-mode combination (increment /
// decrement / fixed / IO port), plus short-init and CONTINUE reuse
// tests, painting each transfer's bytes INTO the attribute area — the
// attribute map IS the verdict. It then prints the 16 bytes its DMA
// read-back sequences returned and finishes with a slow auto-restart
// burst fill paced by the prescaler while an IM2 handler cycles the
// fill colour and steps the CPU speed every 2s.
//
// Attribute expectations are derived from the upstream Main.asm
// (constants: ATTR_NO_DMA=$22 green/red frame, ATTR_DMA=$14,
// ATTR_DMA_B=$54 bright start/end markers, ATTR_IO=$56 yellow) — the
// colour-coded verdicts the ReadMe describes ("IO is yellow colour
// when OK"; dark green ahead/after means no over-run). The MAME 0.282
// capture shows the same green/yellow matrix.
//
// The read-back row is adjudicated against dma.vhd (the FPGA read
// state machine), NOT against the captures: the board photo (core
// 3.00.5) predates the hex display and MAME 0.281's read-back is not
// conformant (CD/38/19 bytes). Expected stream:
//
//	3A            read with nothing requested: status via the reset
//	              read state (endofblock_n=1, atleastone=0)
//	3A            after $BF READ STATUS (dma.vhd:687)
//	1A 04 04 2A   masked sequence (status, counter lo, port A lo,
//	              port B lo) after the first 4-byte A->B transfer:
//	              endofblock latched, counter 4, src DmaSrcData4B+4,
//	              dst $5826+4
//	1A            sequence wrap: status again
//	1A 04 D1 04 1A  after the short-init MSB B->A transfer to $58CD
//	1A 04 D5 08   after the CONTINUE transfer (+4 from current
//	              pointers: dst $58D1+4, src DmaSrcData9B+8)
func TestNexttestsDMA(t *testing.T) {
	h := runNexttestsSNX(t, "dma.snx", 240)

	text := h.ScreenText()
	if !strings.Contains(text, "3A3A1A04042A1A1A04D1041A1A04D508") {
		t.Errorf("DMA read-back stream missing or wrong; row = %q",
			screenLine(text, "3A"))
	}

	// Border goes blue when the test reaches its burst-fill stage.
	if got := h.ULA().BorderColour; got != 1 {
		t.Errorf("border = %d, want 1 (blue = test completed)", got)
	}

	// The transfer-verdict attribute map, rows 0..14. Layout per
	// Main.asm's screen init: each mode row frames three test areas
	// in $22 at cols 5-10, 17-22 and 29-31; the four transferred
	// bytes land at cols 6-9 / 18-21 (decrementing targets write
	// right-to-left) / col 30 (fixed). The source pattern is
	// bright,bright,plain,bright ($54/$14), so the byte order the
	// transfer delivered is visible in the marker positions.
	rep := strings.Repeat
	const (
		mP = "54541454" // pattern via incrementing source
		mM = "54145454" // via decrementing source (order reversed)
		m0 = "54545454" // via fixed source (last byte everywhere)
		io = "56565656" // via IO source: ATTR_IO yellow ("IO is yellow when OK")
	)
	modeRow := func(base, viaP, viaM string) string {
		return rep(base, 5) + "22" + viaP + "22" + rep(base, 6) + "22" + viaM + "22" + rep(base, 6) + "22" + "54" + "22"
	}
	ioRow := func(base string) string {
		return rep(base, 5) + "22" + io + "22" + rep(base, 6) + "22" + io + "22" + rep(base, 6) + "22" + "56" + "22"
	}
	wantRows := [15]string{
		0: rep("38", 32),
		1: modeRow("28", mP, mM), // m+ source: m+ / m- / m0 targets
		2: modeRow("38", mM, mP), // m- source reverses the delivered order
		3: modeRow("28", m0, m0), // m0 source repeats its last byte
		4: ioRow("38"),
		5: rep("2F", 32),
		// Short-init 4+4+1: one 9-byte area (two bright at start, one
		// at end — the CONTINUE test's contract from the ReadMe).
		6:  rep("38", 12) + "22" + "54" + "54" + rep("14", 6) + "54" + "22" + rep("38", 9),
		7:  rep("28286868", 8), // hex read-back row: cyan, alternating bright
		8:  rep("38", 32),
		9:  modeRow("28", mP, mM),
		10: modeRow("38", mM, mP),
		11: modeRow("28", m0, m0),
		12: ioRow("38"),
		13: rep("28", 32),
		// Short cont 4+4: two 4-byte areas with a gap column.
		14: rep("38", 12) + "22" + mP + "22" + mM + "22" + rep("38", 9),
	}
	rowHex := func(row int) string {
		s := ""
		for col := 0; col < 32; col++ {
			s += fmt.Sprintf("%02X", h.Memory(uint16(0x5800+row*32+col)))
		}
		return s
	}
	for row := 0; row < 15; row++ {
		if got := rowHex(row); got != wantRows[row] {
			t.Errorf("attr row %d:\n got %s\nwant %s", row, got, wantRows[row])
		}
	}

	// Burst area (rows 16..21): the auto-restart prescaler burst
	// repaints it continuously with the IM2 handler's colour orbit
	// (((a+9)|$20)&$3F = values $20..$3F). The initial pre-fill was
	// P_WHITE|RED = $3A too, so repaint is proven by every cell
	// sitting in the orbit AND the area holding at most a few
	// mid-fill bands (a stalled burst would be a single $3A field —
	// caught by the marker-row assert below plus the band values).
	distinct := map[byte]bool{}
	for row := 16; row <= 21; row++ {
		for col := 0; col < 32; col++ {
			v := h.Memory(uint16(0x5800 + row*32 + col))
			if v < 0x20 || v > 0x3F {
				t.Fatalf("burst area [%d,%d] = $%02X, outside the IM2 colour orbit", row, col, v)
			}
			distinct[v] = true
		}
	}
	if len(distinct) > 4 {
		t.Errorf("burst area holds %d distinct colours, want <= 4 mid-fill bands", len(distinct))
	}

	// CPU-speed marker row (22): the IM2 handler steps NR$07 every 2s
	// of interrupts — and its timer seeds at 200, so the FIRST step
	// fires on the first interrupt (~frame 3), then every 100 frames:
	// 28MHz -> 3.5 -> 7 -> 14. At 240 frames three steps have run, so
	// the cyan current-speed marker sits on the "14" slot (cols
	// 10..13) and the passed slots show the bright-white-blue clear
	// colour.
	for col := 2; col < 18; col++ {
		want := byte(0x79)
		if col >= 10 && col <= 13 {
			want = 0x28
		}
		if got := h.Memory(uint16(0x5800 + 22*32 + col)); got != want {
			t.Errorf("speed marker col %d = $%02X, want $%02X", col, got, want)
		}
	}
}

// --- Misc/ZilogDMA: the port-$0B Z80-DMA-compatibility decode -----------

// TestNexttestsZilogDMA runs Misc/ZilogDMA, which programs the DMA "in
// Zilog DMA compatible way" through port $0B (the legacy MB-02/Datagear
// decode): every block length is written as N expecting N+1 bytes moved
// (the Zilog convention), fixed-address destinations are LOADed with the
// direction temporarily flipped, and the CONTINUE short-init reuses live
// pointers. On the Next both ports reach the zxnDMA; the accessed port
// latches dma_mode (zxnext.vhd:1811-1819), which seeds the byte counter
// -1 instead of 0 at LOAD/CONTINUE/auto-restart (dma.vhd:482-486) — the
// whole observable difference between the modes.
//
// Every expectation below is pinned to the core-3.1.5 board photo
// (board_3.1.5_hdmi50Hz.jpg upstream) and the upstream ReadMe's
// "TBBLue zxnDMA core 3.1.5" section:
//
//   - hex row 7 "3A3A1A03042A1A1A03D1041A1A03D508": unrequested read +
//     $BF status (3A 3A), then the masked read sequence after the first
//     4-byte transfer (1A 03 04 2A — counter reads 3 for a length-3
//     Zilog transfer that moved 4 bytes) + wrap (1A), after the
//     short-init MSB transfer (1A 03 D1 04, wrap 1A) and after the
//     CONTINUE transfer (1A 03 D5 08).
//   - hex row 13 "1A1A6500FE 1A 1A650B0097FE00": the post-border-block
//     state — counter $0B65 = 2917 for the 2918-byte flashing blocks,
//     port A parked on the fixed source $9700, port B on $00FE.
//   - the A->B / B->A attribute matrices all green (IO rows yellow),
//     with the Zilog +1 filling each 4-cell area exactly; the m0
//     single-cell columns; the 10-wide "Short init (4+4+2)" area (the
//     +2 tail is the Zilog CONTINUE seed on a length-1 reprogram) and
//     the 4+4 "Short cont" row.
//   - the border timing bands: both flashing blocks transfer 2918 bytes
//     to port $FE at 2T+2T cycle timing = 4T/byte ≈ 51 scanlines — the
//     ReadMe's "*4T: 6.5 rows" desired outcome — separated by the
//     white/green/yellow mainline stripes, blue after completion, and
//     the port-$0B nibble painting the top border black.
//
// Knowingly diverging surface: the top-border "DMA"-text transfer (a
// B->A LOAD latching src=$00FE/dst=BorderTextGfx, then flipped to A->B —
// noise on the 3.1.5 photo). The pointer latching IS modelled (the same
// stale-role transfer runs, read back on hex row 13's first pass state),
// but a synchronous continuous-mode transfer stamps all its border
// writes at one raster instant, so the ~24-line noise band collapses to
// its final byte instead of painting stripes (known-gaps.md, zxnDMA
// row). The flashing blocks are immune: their fixed source repeats ONE
// value, so start-to-white band geometry renders exactly.
//
// First run caught two real model gaps: LOAD previously latched
// port-identity pointers (re-deriving roles at ENABLE, so the
// flip-direction border transfer read the WRONG endpoint), and the
// harness Next machine still used the legacy held-frame-INT model, which
// delivered a stale mid-frame INT at the test's first EI+HALT and let
// the next frame INT preempt the flashing blocks (hex row 13 read the
// border-text state).
func TestNexttestsZilogDMA(t *testing.T) {
	h := runNexttestsSNX(t, "zilogDMA.snx", 240)

	text := h.ScreenText()
	if !strings.Contains(text, "3A3A1A03042A1A1A03D1041A1A03D508") {
		t.Errorf("Zilog-mode read-back stream missing or wrong; row = %q",
			screenLine(text, "3A"))
	}
	if line := screenLine(text, "1A1A65"); !strings.Contains(line, "1A1A6500FE") ||
		!strings.Contains(line, "1A650B0097FE00") {
		t.Errorf("post-border-block read-back missing or wrong; row = %q", line)
	}
	if !strings.Contains(text, "DMA port: $0B") {
		t.Errorf("test is not on port $0B; port row = %q", screenLine(text, "DMA port"))
	}

	// The attribute verdict map. Layout per the upstream Main.asm screen
	// init: mode rows frame the test areas in ATTR_NO_DMA=$22 at cols
	// 5-10 / 17-22 / 29-31; the 4 transferred bytes land at cols 6-9,
	// 18-21 (decrementing destinations fill right-to-left) and col 30
	// (fixed). Source pattern bright,bright,plain,bright ($54/$14);
	// IO-source rows read the AY register preloaded with ATTR_IO=$56
	// ("IO is yellow colour when OK"). Row background alternates the
	// $28/$38 cyan/white stripes of the screen init.
	rep := strings.Repeat
	const (
		mP = "54541454" // via incrementing source
		mM = "54145454" // via decrementing source (order reversed)
		m0 = "54545454" // via fixed source (one byte repeated)
		io = "56565656" // via IO source
	)
	modeRow := func(base, viaP, viaM, fixed string) string {
		return rep(base, 5) + "22" + viaP + "22" + rep(base, 6) + "22" + viaM + "22" + rep(base, 6) + "22" + fixed + "22"
	}
	hexRow := rep("28286868", 8) // hex read-back rows: cyan, alternating bright
	wantRows := [24]string{
		0: rep("38", 32),
		1: modeRow("28", mP, mM, "54"), // m+ source
		2: modeRow("38", mM, mP, "54"), // m- source reverses delivery
		3: modeRow("28", m0, m0, "54"), // m0 source repeats its byte
		4: modeRow("38", io, io, "56"), // IO source: yellow
		5: rep("2F", 32),
		// Short init 4+4+2: one 10-byte area, two bright at start, one
		// at end — the Zilog CONTINUE moved 2 bytes where zxn moves 1.
		6:  rep("38", 12) + "22" + "5454" + rep("14", 7) + "54" + "22" + rep("38", 8),
		7:  hexRow,
		8:  rep("38", 32),
		9:  modeRow("28", mP, mM, "54"), // B -> A direction, same matrix
		10: modeRow("38", mM, mP, "54"),
		11: modeRow("28", m0, m0, "54"),
		12: modeRow("38", io, io, "56"),
		// Second hex row is 28 characters (22 hex + spacing), so the
		// last two character pairs keep the plain stripe attribute.
		13: hexRow[:56] + rep("28", 4),
		// Short cont 4+4: two 4-byte areas with a gap column.
		14: rep("38", 12) + "22" + mP + "22" + mM + "22" + rep("38", 9),
		15: rep("79", 32), // blocks info area: bright white on blue
		16: "38" + rep("28", 14) + rep("38", 17),
		17: rep("38", 32),
		18: rep("38", 32),
		19: rep("79", 32),
		20: rep("38", 32),
		21: rep("79", 32),
		22: rep("79", 32),
		23: rep("28", 32),
	}
	for row := 0; row < 24; row++ {
		got := ""
		for col := 0; col < 32; col++ {
			got += fmt.Sprintf("%02X", h.Memory(uint16(0x5800+row*32+col)))
		}
		if got != wantRows[row] {
			t.Errorf("attr row %d:\n got %s\nwant %s", row, got, wantRows[row])
		}
	}

	// Border timing bands, sampled down a left-border column of the
	// rendered frame. Steady state per frame: the IM2 handler paints the
	// port-$0B high nibble (black), the mainline runs flashing block 1
	// (2918 bytes x 4T = 11672T ~= 51 lines of the fill colour), BORDER
	// WHITE + short wait, GREEN + longer wait, YELLOW, block 2 (same
	// geometry — proving the D6=0 re-init kept the 2T+2T timing), WHITE,
	// then BLUE until the next frame INT. The fill colour cycles per
	// frame ((a+1)&7 in the IM2 handler), so the assertion is structural:
	// both blocks identical colour and ~51 lines, stripes in order.
	img := h.ScreenImage()
	type band struct {
		rgb  string
		rows int
	}
	var bands []band
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		c := frameRGB(img, 4, y)
		rgb := fmt.Sprintf("%02X%02X%02X", c[0], c[1], c[2])
		if len(bands) == 0 || bands[len(bands)-1].rgb != rgb {
			bands = append(bands, band{rgb: rgb})
		}
		bands[len(bands)-1].rows++
	}
	const (
		black  = "000000"
		green  = "00B600"
		yellow = "B6B600"
		white  = "B6B6B6"
		blue   = "0000B6"
	)
	structure := []struct {
		rgb      string // "" = the flashing-block fill colour (any, but equal)
		min, max int
	}{
		{black, 26, 32}, // top border (32 rows on the wide frame): IM2 paints port nibble ($0B -> 0)
		{"", 49, 53},    // flashing block 1: 2918 x 4T
		{white, 1, 2},
		{green, 5, 7},
		{yellow, 1, 2},
		{"", 49, 53}, // flashing block 2: same timing
		{white, 1, 2},
		{blue, 100, 256}, // completed: blue for the rest of the frame
	}
	if len(bands) != len(structure) {
		t.Fatalf("border column has %d bands, want %d: %v", len(bands), len(structure), bands)
	}
	var fill string
	for i, want := range structure {
		got := bands[i]
		if got.rows < want.min || got.rows > want.max {
			t.Errorf("border band %d (%s): %d rows, want %d-%d", i, got.rgb, got.rows, want.min, want.max)
		}
		switch {
		case want.rgb != "":
			if got.rgb != want.rgb {
				t.Errorf("border band %d: colour %s, want %s", i, got.rgb, want.rgb)
			}
		case fill == "":
			fill = got.rgb
			if fill == black || fill == blue {
				t.Errorf("flashing-block fill %s would be invisible against the frame stripes", fill)
			}
		case got.rgb != fill:
			t.Errorf("flashing block colours differ (%s vs %s): an interrupt split the blocks", fill, got.rgb)
		}
	}

	if got := h.ULA().BorderColour; got != 1 {
		t.Errorf("border = %d, want 1 (blue = pass completed)", got)
	}
}

// --- base/NextReg_defaults: the per-register NextReg availability +
// default-value audit ---------------------------------------------------
//
// NextReg.snx walks every register $00-$FF in order, read-testing the
// default value and write-testing a benign value + read-back, and paints
// register r's verdict into the ULA attribute cell at column r&15, row
// r>>4 of a 16x16 grid (attr $5800 + (r>>4)*32 + (r&15)). The three
// tables below are transcribed verbatim from the upstream Main.asm
// (develop branch — the vendored NextReg.snx is byte-identical to that
// build's !NextReg.snx), and together they fully determine the verdict
// of a conformant machine, including sequential side-effects (NR$61
// reads $01 because NR$60's write test advanced the copper byte
// address; NR$1C reads $E4 because the clip tests left the four indices
// at 0,1,2,3).

// nextRegDefaultRead: expected default-read value per register.
// $FF = no readable register (skip), $FE = any value, $FD = any
// non-zero value, $FC = custom code; else exact match required.
var nextRegDefaultRead = [256]byte{
	0xFD, 0xFD, 0xFE, 0xFD, 0xFF, 0xFE, 0xFE, 0x00, 0xFE, 0xFE, 0xFE, 0xFF, 0xFF, 0xFF, 0xFE, 0xFF, // $00
	0x00, 0xFE, 0x08, 0x0B, 0xE3, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xE4, 0xFF, 0xFE, 0xFE, // $10
	0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFE, 0xFE, 0xFE, 0x00, // $20
	0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $30
	0x00, 0x00, 0x07, 0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xE3, 0xE3, 0x0F, 0xFF, 0xFF, 0xFF, // $40
	0xFD, 0xFD, 0x0A, 0x0B, 0x04, 0x05, 0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $50
	0xFF, 0x01, 0x00, 0xFF, 0x00, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x2C, 0x0C, // $60
	0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFD, // $70
	0x00, 0x00, 0xFD, 0xFD, 0xFD, 0xFD, 0xFD, 0xFD, 0xFD, 0xFD, 0x00, 0xFF, 0x00, 0xFF, 0x08, 0xFF, // $80
	0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xFE, 0xFE, 0xFE, 0xFF, 0xFF, 0xFF, 0xFF, // $90
	0xFE, 0xFF, 0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $A0
	0xFE, 0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $B0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $C0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $D0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $E0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $F0
}

// nextRegWriteInfo: write-test value per register. $FF = not
// writeable (skip), $FE = too specific to test (write skipped),
// $FC = custom code; values $80-$FB have their low 7 bits ORed with
// the default read before writing.
var nextRegWriteInfo = [256]byte{
	0xFF, 0xFF, 0x00, 0xFE, 0xFE, 0x80, 0xFC, 0x01, 0x74, 0x18, 0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $00
	0xFE, 0xFE, 0x09, 0x0A, 0x25, 0x02, 0x55, 0x56, 0xFC, 0xFC, 0xFC, 0xFC, 0x08, 0xFF, 0xFF, 0xFF, // $10
	0xFF, 0xFF, 0x01, 0x02, 0xFF, 0xFF, 0x02, 0x01, 0xFE, 0xFE, 0xFE, 0xFE, 0x7F, 0x7F, 0x7F, 0x01, // $20
	0x03, 0x06, 0x02, 0x01, 0x7B, 0x00, 0x00, 0x0F, 0x3F, 0x0A, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $30
	0x70, 0x1F, 0x03, 0x68, 0xFC, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x1F, 0x20, 0x0E, 0xFF, 0xFF, 0xFF, // $40
	0x80, 0x80, 0x0A, 0x0B, 0x04, 0x05, 0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $50
	0x00, 0x33, 0x01, 0x00, 0x20, 0xFF, 0xFF, 0xFF, 0x40, 0x00, 0x02, 0x60, 0x0F, 0xFF, 0x5B, 0x5C, // $60
	0x14, 0x01, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x0F, 0x3F, 0x0A, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x13, // $70
	0x10, 0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10, 0xFF, 0x30, 0xFF, 0x03, 0xFF, // $80
	0xFE, 0xFE, 0xFE, 0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xFE, 0xFE, 0xFE, 0xFF, 0xFF, 0xFF, 0xFF, // $90
	0xFE, 0xFF, 0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xFE, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $A0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $B0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $C0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $D0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $E0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $F0
}

// nextRegWriteVerify: expected read-back after the write test.
// $FF = no read-back test (a green result drops to cyan), $FE =
// must match the original default read; else exact value.
var nextRegWriteVerify = [256]byte{
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xFF, 0x11, 0x74, 0x10, 0x07, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $00
	0xFF, 0xFF, 0x09, 0x0A, 0x25, 0x02, 0x55, 0x56, 0xFF, 0xFF, 0xFF, 0xFF, 0x24, 0xFF, 0xFF, 0xFF, // $10
	0xFF, 0xFF, 0x01, 0x02, 0xFF, 0xFF, 0x02, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, // $20
	0x03, 0x06, 0x02, 0x01, 0x7B, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $30
	0x70, 0x02, 0x03, 0x68, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x1F, 0x20, 0x0E, 0xFF, 0xFF, 0xFF, // $40
	0xFE, 0xFE, 0x0A, 0x0B, 0x04, 0x05, 0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $50
	0xFF, 0x33, 0x01, 0xFF, 0x20, 0xFF, 0xFF, 0xFF, 0x40, 0x00, 0x02, 0x60, 0x0F, 0xFF, 0x1B, 0x1C, // $60
	0x14, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x13, // $70
	0x10, 0x00, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0xFE, 0x10, 0xFF, 0x30, 0xFF, 0x0B, 0xFF, // $80
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $90
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $A0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $B0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $C0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $D0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $E0
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // $F0
}

// nextRegResultAttr converts the test's result enum (Main.asm's
// ResultToPaperColourConversion) to the attribute byte it paints:
// paper colour in bits 5:3, bright bit 6, flash bit 7, ink black.
var nextRegResultAttr = [13]byte{
	0x38, // 0  none (no NextReg)            white
	0x68, // 1  read any                     bright cyan
	0x60, // 2  read OK (strict)             bright green
	0x50, // 3  read / write-verify ERROR    bright red
	0x78, // 4  none + write skipped         bright white
	0x28, // 5  read any + write skipped     cyan
	0x20, // 6  read OK + write skipped      green
	0x50, // 7  read ERR + write skipped     bright red
	0x58, // 8  write done (no read)         bright magenta
	0x68, // 9  read any + write done        bright cyan
	0x60, // 10 read OK + write done/verified bright green
	0x30, // 11 default ERR, write verified   yellow
	0x98, // 12 debug                        flashing magenta
}

var nextRegAttrLetter = map[byte]string{
	0x38: ".", 0x68: "C", 0x60: "G", 0x50: "R", 0x78: "W", 0x28: "c",
	0x20: "g", 0x58: "M", 0x30: "Y", 0x98: "!", 0x48: "B",
}

// nextRegExpectedResult computes the verdict a fully-conformant
// machine earns for one register, mirroring Main.asm's result-enum
// state machine with every comparison assumed to pass.
func nextRegExpectedResult(reg int) int {
	e := 0
	switch nextRegDefaultRead[reg] {
	case 0xFF:
	case 0xFE:
		e = 1
	case 0xFC:
		e = 12 // custom read — unused upstream
	default: // strict / non-zero, assumed to pass
		e = 2
	}
	switch nextRegWriteInfo[reg] {
	case 0xFF:
	case 0xFE:
		e |= 4
	case 0xFC:
		// Custom write tests: NR$06 (masked peripheral-2 write),
		// NR$18-$1B (clip windows — the custom code seeds its own
		// read-OK result), NR$44 (9-bit palette pair). All verify
		// their read-back.
		if reg >= 0x18 && reg <= 0x1B {
			e = 2
		}
		e |= 8
	default:
		e |= 8
		if nextRegWriteVerify[reg] == 0xFF && e == (2|8) {
			e = 1 | 8 // no read-back test: green drops to cyan
		}
	}
	return e
}

// TestNexttestsNextRegDefaults runs base/NextReg_defaults and asserts
// the complete 256-cell verdict grid.
//
// Preconditions: the test expects a machine "booted into ZX48
// personality with Next features mostly OFF" (release/!NextReg.txt).
// The harness Next already satisfies the register file part (power-on
// defaults + no turbo); the one personality-specific bit is the
// classic 7FFD paging LOCK (NR$08 bit 7 reads NOT port_7ffd_locked and
// the write test expects it low), applied here the way NextZXOS's
// 48K personality does — an OUT to $7FFD with bit 5 set.
//
// The asserted map is the ideal all-tables-pass verdict, with two
// documented core-version deviations (zx_go reports core 3.2.3 and is
// adjudicated against the master zxnext.vhd; the upstream test targets
// core 3.1.5):
//
//   - NR$0A red: the test writes $07 and expects $07 back; since
//     core 3.2 the mouse-button-reverse bit sits at bit 3 and bit 2
//     reads hard-zero (zxnext.vhd:5197 write / :5912 read), so the
//     read-back is $03. MAME 0.282 (core 3.2.1) fails identically —
//     its reference capture logs the red pair "03 0A".
//   - NR$10 red: the test expects $00; the composed read is
//     '0' & coreid("00001") & buttons = $04 on 3.2 cores
//     (zxnext.vhd:1133 + :5923). MAME logs the same "04 10".
//
// Against the core-3.1.5 real-board photo the remaining difference is
// six cells the BOARD shows yellow ($12,$13,$14,$42,$4A,$8C):
// NextZXOS boot side-effects on the board (its log pairs match the OS
// boot values), where the OS-less harness legitimately earns the
// stricter green. $8E matches the board EXACTLY since the .snx loader
// reproduces the NextZXOS 48K-launch ROM state (ROM bank 3 → $8E reads
// the board's $0B, yellow).
func TestNexttestsNextRegDefaults(t *testing.T) {
	installtest.RedirectConfig(t)
	installFakeDistroForLoad(t)
	h, err := New(roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.CloseFiles)
	if err := h.LoadSnapshot(filepath.Join("testdata", "nexttests", "NextReg.snx")); err != nil {
		t.Fatal(err)
	}
	// ZX48 personality: classic paging locked (see doc comment).
	h.ULA().WritePort(0x7FFD, 0x20)
	h.RunFrames(400)

	got := make([]string, 0, 16)
	fails := 0
	for row := 0; row < 16; row++ {
		line := ""
		for col := 0; col < 16; col++ {
			reg := row*16 + col
			attr := h.Memory(uint16(0x5800 + row*32 + col))
			letter, known := nextRegAttrLetter[attr]
			if !known {
				letter = "?"
			}
			line += letter
			want := nextRegResultAttr[nextRegExpectedResult(reg)]
			switch reg {
			case 0x0A, 0x10: // core 3.2.x deviations, see doc comment
				want = 0x50
			case 0x8E:
				// The .snx loader now reproduces the NextZXOS 48K-launch
				// paging state (ROM bank 3 selected — see
				// applySnapshotFile), so NR$8E reads $0B and this cell
				// goes yellow EXACTLY like the reference board photo
				// (whose NextZXOS log pair is $8E=$0B; see doc comment).
				want = 0x30
			}
			if attr != want {
				fails++
				t.Errorf("NR$%02X verdict = %s (attr $%02X), want %s (attr $%02X)",
					reg, letter, attr, nextRegAttrLetter[want], want)
			}
		}
		got = append(got, fmt.Sprintf("%Xx  %s", row, line))
	}
	if fails > 0 {
		t.Logf("verdict grid (G/g=OK C/c=weakOK W=skip M=done Y=dERR R=ERROR B=freeze):\n%s",
			strings.Join(got, "\n"))
	}
}
