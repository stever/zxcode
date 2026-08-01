package testharness

// MrKWatkins/ZXSpectrumNextTests — Timing group + the classic ULAvsSJS
// test (work item: conformance dashboard rows Timing/Changing8kBank,
// Timing/Changing8kBank_NoContention, Timing/ScanlineReadingAndInterrupt,
// ZX48_ZX128/ULAvsSJS).
//
// The Timing group has NO real-board reference photos upstream — only
// MAME 0.282 captures — so verdicts here are pinned by arithmetic
// against the FPGA sources (video/zxula_timing.vhd via
// pkg/next.FrameIntTiming, Z80N instruction T-states) and cross-checked
// against the MAME captures' proportions.

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
)

// timingColour classifies a rendered pixel into the palette values the
// Timing-group programs write (9-bit palette projections through the
// live ULA render).
func timingColour(r, g, b byte) string {
	type c struct {
		name    string
		r, g, b byte
	}
	for _, k := range []c{
		{"white", 182, 182, 182},
		{"green", 0, 109, 0},
		{"cyan", 0, 109, 109},
		{"copper", 146, 73, 0},
		{"yellowish", 182, 109, 0},
		{"black", 0, 0, 0},
		{"bordergreen", 0, 182, 0}, // border 4 through the live ULA palette (9-bit green)
	} {
		if r == k.r && g == k.g && b == k.b {
			return k.name
		}
	}
	return fmt.Sprintf("rgb(%d,%d,%d)", r, g, b)
}

// --- Timing/Changing8kBank (+ _NoContention) ----------------------------
//
// The program HALTs for the frame interrupt, sets the border green,
// switches MMU slot 6 through 16 banks 128 times (2048 Z80N
// `NEXTREG r,n` instructions, 20 T-states each — the timing under
// test), then sets the border black and loops. The verdict is the SIZE
// of the green border band.
//
// Expected transition, derived from the instruction stream and the
// frame-INT model (pkg/next/inttiming.go, zxula_timing.vhd):
//
//	work = 2048×20 (NEXTREG r,n)
//	     + 127×13+8 (DJNZ)
//	     + ld b,7 + call/ret ×2 + jr + the Start/EndTiming bodies
//	     ≈ 42.7k T-states ≈ 187 raster lines at 228 T/line.
//
// The green band starts ~4 raster lines after the frame INT (INT ack +
// the ROM ISR + HALT exit + StartTiming ≈ 0.9-1.1k T) and ends 187
// lines later at raster ~191 = image row 151 (transition measured and
// pinned below; border-change raster stamps observed at lines 4 and
// 191). MAME 0.282's capture shows the same proportion (transition at
// ~62% of the frame; ours is 151/240 = 62.9% — MAME runs the FPGA's
// 448-hcount 48K display timing where zxplay_go's Next keeps the 128K-
// flavour 228 T line, a catalogued difference of ~2%, see
// known-gaps.md).
//
// The NoContention variant (NR$08 bit 6 set) keeps the 159±2 band —
// it matches MAME 0.282's capture and the uncontended 20T-per-NEXTREG
// arithmetic. The contention-ON variant now runs SLOWER, as a real
// board does: per-access ULA contention went machine-wide at the
// readMem/writeMem choke point (#189), so the ON band is taller. MAME
// 0.282's two captures match pixel-for-pixel because MAME shares our
// former deferral; no board photo exists upstream to pin the true
// delta, so the ON band is pinned to observed behaviour with wide
// slack — its VALUE is a model artefact, but its DIRECTION (ON > OFF)
// is hardware-required (zxnext.vhd:4481 gates contention on
// cpu_speed=00).
func chg8kBandTransition(t *testing.T, snx, verdict string, lo, hi int) int {
	t.Helper()
	h := runNexttestsSNX(t, snx, 100)
	text := h.ScreenText()
	if !strings.Contains(text, verdict) {
		t.Fatalf("missing verdict text %q:\n%s", verdict, text)
	}
	img := h.ScreenImage()
	// The border band: green from the image top, black to the image
	// bottom, one transition. Sample both borders.
	transition := -1
	for _, x := range []int{4, 316} {
		last := ""
		trans := -1
		for y := 0; y < img.Bounds().Dy(); y++ {
			c := frameRGB(img, x, y)
			cls := timingColour(c[0], c[1], c[2])
			if cls != "bordergreen" && cls != "black" {
				t.Fatalf("border x=%d y=%d: unexpected colour %s", x, y, cls)
			}
			if last == "black" && cls == "bordergreen" {
				t.Fatalf("border x=%d y=%d: green after black (band must be a single run)", x, y)
			}
			if last == "bordergreen" && cls == "black" {
				trans = y
			}
			last = cls
		}
		if trans < 0 {
			t.Fatalf("border x=%d: no green->black transition found", x)
		}
		if transition >= 0 && trans != transition {
			t.Fatalf("left/right border transitions disagree: %d vs %d", transition, trans)
		}
		transition = trans
	}
	// Uncontended: 2048 NEXTREG r,n at 20T ≈ 187 lines of green ending
	// at raster ~191 → image row 159 (wide frame: raster − 32). ±2 rows
	// of slack for the launch ISR cost. The contended variant runs
	// longer; its window is passed in by the caller.
	if transition < lo || transition > hi {
		t.Errorf("green band ends at image row %d, want %d-%d (2048×20T NEXTREG work)", transition, lo, hi)
	}
	// The attribute rainbow down column 0 (bright, paper cycling
	// green->cyan->... by +P_BLUE with green forced back in) is static
	// content the program draws once — pin the first cells.
	for row, want := range []byte{0x60, 0x68, 0x70, 0x78} {
		got := h.Memory(uint16(0x5800 + row*32))
		if got != want {
			t.Errorf("attr rainbow row %d = %02X, want %02X", row, got, want)
		}
	}
	return transition
}

func TestNexttestsChanging8kBank(t *testing.T) {
	on := chg8kBandTransition(t, "Chg8kBan.snx", "256x 8k switch, contention ON", 166, 178)
	off := chg8kBandTransition(t, "Chg8kB_2.snx", "256x 8k switch, contention OFF", 157, 161)
	// Contention ON must cost real time: the ULA holds the CPU off the
	// contended page set during the display window (zxnext.vhd:4481,
	// gated on cpu_speed=00), so the same 2048-NEXTREG workload takes
	// longer and its green band is taller. Pinned as an inequality
	// because the exact delta is model-derived — MAME 0.282's captures
	// show the pair identical, sharing the deferral zxplay_go dropped in
	// #189, so there is no external reference for the magnitude.
	if on <= off {
		t.Errorf("contention ON transition %d must exceed OFF %d — contention costs time", on, off)
	}
}

// --- Timing/ScanlineReadingAndInterrupt ---------------------------------
//
// Interactive Z80N raster instrument (linesIRQ.snx): paints the ULA
// palette's white-paper entry (index 23, which the border ALSO
// resolves through — border 7 reads palette entry 16+7) for exactly
// the raster lines matching the target, in three modes cycled by Z:
//   READ   — busy-waits on NR$1F (raster line LSB, cvc convention:
//            0 = top paper line) and flashes the entry green for one
//            line. Values ≤ 54 match twice per frame (cvc n and
//            n+256, the second landing in the displayed top border).
//            The upstream ReadMe documents that this marker starts
//            "somewhat midway" through the desired line (the poll
//            catches the line mid-scan), so at the render's one-line
//            stamp granularity the row is target or target+1
//            depending on the poll phase — assertions allow both.
//   INTER. — NR$22/$23 line interrupt; the IM2 handler flashes cyan.
//   COPPER — a copper list WAITs on the target line and paints
//            copper-red from the paper's left edge to H=52.
// This row drove the raster-stamped palette-CONTENT replay
// (palette.Bank stamped-write log, zxnext.vhd:4919-4930 — a BRAM
// write is visible to the video fetch on the next pixel).

// linesIRQTarget reads the test's on-screen "Target line LSB" value.
func linesIRQTarget(t *testing.T, h *Harness) int {
	t.Helper()
	line := screenLine(h.ScreenText(), "Target line LSB:")
	fields := strings.Fields(line)
	v, err := strconv.Atoi(fields[len(fields)-1])
	if err != nil {
		t.Fatalf("cannot parse target from %q", line)
	}
	return v
}

// linesIRQRows scans a full-frame column for rows matching colour cls.
func linesIRQRows(h *Harness, x int, cls string) []int {
	img := h.ScreenImage()
	var rows []int
	for y := 0; y < img.Bounds().Dy(); y++ {
		c := frameRGB(img, x, y)
		if timingColour(c[0], c[1], c[2]) == cls {
			rows = append(rows, y)
		}
	}
	return rows
}

func linesIRQTap(h *Harness, row int, mask byte) {
	h.kbd.PressMatrixKey(row, mask, true)
	h.RunFrames(4)
	h.kbd.PressMatrixKey(row, mask, false)
	h.RunFrames(10)
}

func TestNexttestsScanlineIRQ(t *testing.T) {
	h := runNexttestsSNX(t, "linesIRQ.snx", 120)
	text := h.ScreenText()
	for _, want := range []string{
		"machineID:10", "core:3.02.3",
		"Q/A:  Target line LSB: 200",
		"Z:    NR_$1F INTER. COPPER",
		"O/K:  Line offset $64: 0",
		"[linesIRQ.snx]",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}

	// READ mode, default target 200 (8 px below the paper): exactly one
	// full-width green row at image y = 24+200 = 224 — cvc 200 is the
	// raster line NR$1E/$1F report (zxnext.vhd:5982, port_253b_dat <=
	// cvc; 0 = top paper line), so the marker must land 8 rows under
	// the paper bottom. Full-width because the border resolves through
	// the same palette entry the flash rewrites.
	for _, x := range []int{4, 160, 316} {
		rows := linesIRQRows(h, x, "green")
		if len(rows) != 1 || rows[0] < 232 || rows[0] > 233 {
			t.Errorf("READ@200 x=%d: green rows %v, want exactly one at 232..233", x, rows)
		}
	}

	// Move the target up into the paper with W (target -= 8 per
	// registered press, auto-repeat applies) and re-derive the row from
	// the test's own UI read-back.
	for i := 0; i < 3; i++ {
		linesIRQTap(h, 2, 0x02) // W
	}
	target := linesIRQTarget(t, h)
	if target >= 192 || target < 100 {
		t.Fatalf("target after W taps = %d, want a paper line in [100,191]", target)
	}
	if rows := linesIRQRows(h, 4, "green"); len(rows) != 1 || rows[0] < 32+target || rows[0] > 33+target {
		t.Errorf("READ@%d: green rows %v, want one at %d..%d", target, rows, 32+target, 33+target)
	}

	// Drive the target below 55 to exercise the double trigger the
	// upstream ReadMe documents: NR$1F is only 8 bits, so LSB n also
	// matches cvc n+256, which scans in the DISPLAYED TOP BORDER
	// (raster n+9, image row n-23) — before the paper. This pins the
	// render's top-border replay pass.
	for i := 0; i < 12 && linesIRQTarget(t, h) > 54; i++ {
		linesIRQTap(h, 2, 0x02) // W
	}
	target = linesIRQTarget(t, h)
	if target > 54 || target < 31 {
		t.Fatalf("target after W taps = %d, want [31,54] for the dual-trigger scene", target)
	}
	if rows := linesIRQRows(h, 4, "green"); len(rows) != 2 ||
		rows[0] < target-23 || rows[0] > target-22 ||
		rows[1] < 32+target || rows[1] > 33+target {
		t.Errorf("READ@%d: green rows %v, want [%d..%d %d..%d] (top-border echo + paper)",
			target, rows, target-23, target-22, 32+target, 33+target)
	}

	// INTERRUPT mode (Z): the NR$22/$23 line interrupt fires at the end
	// of the line BEFORE the target (WireLineInterrupt models
	// target-1+64 raster lines) and the IM2 handler paints cyan for
	// ~340 T (about 1.5 lines). At the render's one-line stamp
	// granularity the band starts one row before the target's row and
	// spans 2-3 rows.
	linesIRQTap(h, 0, 0x02) // Z
	target = linesIRQTarget(t, h)
	rows := linesIRQRows(h, 4, "cyan")
	if len(rows) < 1 || len(rows) > 3 {
		t.Fatalf("INTER@%d: cyan rows %v, want a 1-3 row band", target, rows)
	}
	if start := rows[0]; start != 32+target-1 && start != 32+target {
		t.Errorf("INTER@%d: cyan band starts at %d, want %d±1", target, start, 32+target)
	}

	// COPPER mode (Z again): the copper list WAITs for the target line
	// and paints copper-red from the paper's left edge to H=52 (past
	// the visible right edge), restoring white on the 9th-bit pass.
	// The left border stays white; the paper + right border of exactly
	// the target row turn copper-red. The second (yellowish) line at
	// cvc target+256 falls on a top-border row, which resolves at
	// end-of-line copper state — below the render's border-row
	// granularity floor (the endorsed #144 copper residual), so it is
	// deliberately not asserted.
	linesIRQTap(h, 0, 0x02) // Z
	target = linesIRQTarget(t, h)
	if rows := linesIRQRows(h, 160, "copper"); len(rows) != 1 || rows[0] != 32+target {
		t.Errorf("COPPER@%d: paper copper rows %v, want [%d]", target, rows, 32+target)
	}
	if rows := linesIRQRows(h, 316, "copper"); len(rows) != 1 || rows[0] != 32+target {
		t.Errorf("COPPER@%d: right-border copper rows %v, want [%d]", target, rows, 32+target)
	}
	if rows := linesIRQRows(h, 4, "copper"); len(rows) != 0 {
		t.Errorf("COPPER@%d: left border must stay white, got copper rows %v", target, rows)
	}

	// Z once more cycles back to READ — the instrument keeps working
	// (guards against one-shot mode latches).
	linesIRQTap(h, 0, 0x02) // Z
	target = linesIRQTarget(t, h)
	if rows := linesIRQRows(h, 4, "green"); len(rows) == 0 ||
		rows[len(rows)-1] < 32+target || rows[len(rows)-1] > 33+target {
		t.Errorf("READ again @%d: green rows %v, want last at %d..%d", target, rows, 32+target, 33+target)
	}
}

// --- ZX48_ZX128/ULAvsSJS -------------------------------------------------
//
// Keyboard/Sinclair-joystick port-mixing test (48K machine): live
// readings of ports $00FE (whole 8x5 matrix), $F7FE (keys 54321) and
// $EFFE (67890). On a regular ZX every zero bit read at $F7FE/$EFFE
// must also read zero at $00FE (the all-rows read is the AND of the
// half-rows) — the "difference detected" message must stay hidden and
// the border stays cyan. The grey +2's SJS-only-on-specific-ports
// quirk the test hunts for must NOT appear.
const (
	ulaVsSJSAttr00FE = 0x5800 + 3*32 + 12 // bit 0 cell; bits 1-4 at -1..-4
	ulaVsSJSAttrF7FE = 0x5800 + 4*32 + 12
	ulaVsSJSAttrEFFE = 0x5800 + 5*32 + 12
	ulaVsSJSAttrDiff = 0x5800 + 7*32 + 1 // 21 cells of the hidden message
	ulaVsSJSPressed  = 0x55              // bright red paper / cyan ink
	ulaVsSJSReleased = 0x7F              // bright white on white
	ulaVsSJSHidden   = 0x3F              // white on white
)

func ulaVsSJSBits(h *Harness, base uint16) [5]byte {
	var bits [5]byte
	for i := 0; i < 5; i++ {
		bits[i] = h.Memory(base - uint16(i))
	}
	return bits
}

func assertULAvsSJSClean(t *testing.T, h *Harness, ctx string) {
	t.Helper()
	if got := h.ULA().BorderColour; got != 5 {
		t.Errorf("%s: border = %d, want 5 (cyan; 2/6 signal a detected difference)", ctx, got)
	}
	for i := 0; i < 21; i++ {
		if got := h.Memory(uint16(ulaVsSJSAttrDiff + i)); got != ulaVsSJSHidden {
			t.Errorf("%s: 'difference detected' cell %d = %02X, want hidden %02X", ctx, i, got, ulaVsSJSHidden)
			break
		}
	}
}

func assertULAvsSJSRow(t *testing.T, h *Harness, ctx, name string, base uint16, pressedMask byte) {
	t.Helper()
	bits := ulaVsSJSBits(h, base)
	for i := 0; i < 5; i++ {
		want := byte(ulaVsSJSReleased)
		if pressedMask&(1<<i) != 0 {
			want = ulaVsSJSPressed
		}
		if bits[i] != want {
			t.Errorf("%s: %s bit %d attr = %02X, want %02X (row attrs %02X)", ctx, name, i, bits[i], want, bits)
			break
		}
	}
}

func TestNexttestsULAvsSJS(t *testing.T) {
	h := runNexttestsSNA(t, "ULAvsSJS.sna", 200)
	text := h.ScreenText()
	for _, want := range []string{
		"Reading keyboard ports:",
		"0x00FE: ##### (whole 8x5 matrix)",
		"0xF7FE: ##### (54321)",
		"0xEFFE: ##### (67890)",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	assertULAvsSJSClean(t, h, "baseline")
	assertULAvsSJSRow(t, h, "baseline", "00FE", ulaVsSJSAttr00FE, 0)
	assertULAvsSJSRow(t, h, "baseline", "F7FE", ulaVsSJSAttrF7FE, 0)
	assertULAvsSJSRow(t, h, "baseline", "EFFE", ulaVsSJSAttrEFFE, 0)

	press := func(row int, mask byte, down bool) {
		h.kbd.PressMatrixKey(row, mask, down)
		h.RunFrames(20)
	}

	// "1" (row 3 bit 0, port $F7FE): must appear in BOTH the half-row
	// and the whole-matrix reading, and only there.
	press(3, 0x01, true)
	assertULAvsSJSRow(t, h, "press 1", "00FE", ulaVsSJSAttr00FE, 0x01)
	assertULAvsSJSRow(t, h, "press 1", "F7FE", ulaVsSJSAttrF7FE, 0x01)
	assertULAvsSJSRow(t, h, "press 1", "EFFE", ulaVsSJSAttrEFFE, 0)
	assertULAvsSJSClean(t, h, "press 1")
	press(3, 0x01, false)

	// "6" (row 4 bit 4, port $EFFE).
	press(4, 0x10, true)
	assertULAvsSJSRow(t, h, "press 6", "00FE", ulaVsSJSAttr00FE, 0x10)
	assertULAvsSJSRow(t, h, "press 6", "F7FE", ulaVsSJSAttrF7FE, 0)
	assertULAvsSJSRow(t, h, "press 6", "EFFE", ulaVsSJSAttrEFFE, 0x10)
	assertULAvsSJSClean(t, h, "press 6")
	press(4, 0x10, false)

	// "1"+"6" together across two half-rows: $00FE is the AND of all
	// rows, so both bits show there.
	press(3, 0x01, true)
	press(4, 0x10, true)
	assertULAvsSJSRow(t, h, "press 1+6", "00FE", ulaVsSJSAttr00FE, 0x11)
	assertULAvsSJSRow(t, h, "press 1+6", "F7FE", ulaVsSJSAttrF7FE, 0x01)
	assertULAvsSJSRow(t, h, "press 1+6", "EFFE", ulaVsSJSAttrEFFE, 0x10)
	assertULAvsSJSClean(t, h, "press 1+6")
	press(3, 0x01, false)
	press(4, 0x10, false)

	// "G" (row 1 bit 4) is in neither displayed half-row but must show
	// in the whole-matrix read — and, being a $00FE-only zero bit,
	// must not trip the difference detector (it only fires for
	// half-row bits MISSING from $00FE).
	press(1, 0x10, true)
	assertULAvsSJSRow(t, h, "press G", "00FE", ulaVsSJSAttr00FE, 0x10)
	assertULAvsSJSRow(t, h, "press G", "F7FE", ulaVsSJSAttrF7FE, 0)
	assertULAvsSJSRow(t, h, "press G", "EFFE", ulaVsSJSAttrEFFE, 0)
	assertULAvsSJSClean(t, h, "press G")
	press(1, 0x10, false)

	// Released again after all interaction.
	assertULAvsSJSRow(t, h, "final", "00FE", ulaVsSJSAttr00FE, 0)
	assertULAvsSJSRow(t, h, "final", "F7FE", ulaVsSJSAttrF7FE, 0)
	assertULAvsSJSRow(t, h, "final", "EFFE", ulaVsSJSAttrEFFE, 0)
	assertULAvsSJSClean(t, h, "final")
}
