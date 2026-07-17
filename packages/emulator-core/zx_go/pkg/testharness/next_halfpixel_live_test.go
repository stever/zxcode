package testharness

// End-to-end pins for the #183 stage-3 fused per-half-pixel compose:
// mid-row copper writes to the MIXER state (NR$15 layer priority) and
// to PALETTE CONTENT (NR$40/$41) land on their exact half-pixel for the
// NON-ULA layers too. FPGA oracle: the final mixer samples NR$15 (and
// the rest of the control set) per i_CLK_14 slot (zxnext.vhd:6799-6832,
// :7092-7094), and every layer's colour resolves through the
// sc(0)-multiplexed palette BRAMs once per half-pixel with a write
// visible on the next lookup (:6981/:7033, :6969-6977).

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/install/installtest"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// newHalfPixelLiveHarness boots a Next with: Layer 2 (classic 256x192,
// bank 1) filled with palette index 2 (identity palette -> 9-bit $005,
// the (0,0,182) blue), the ULA paper all white (attr $38 over a zero
// bitmap), and a copper program uploaded via NR$60-$62 started in
// StartOnVBL so it re-runs every frame.
func newHalfPixelLiveHarness(t *testing.T, program []uint16) *Harness {
	t.Helper()
	installtest.RedirectConfig(t)
	installFakeDistroForLoad(t)
	h, err := New(roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.CloseFiles)
	writeReg := func(reg, val byte) {
		h.ULA().WritePort(0x243B, reg)
		h.ULA().WritePort(0x253B, val)
	}
	mem := h.MemoryBus()
	// ULA: white paper everywhere (paper 7, ink 0 over a zero bitmap).
	bank5 := mem.GetPage(5)
	for i := 0x1800; i < 0x1B00; i++ {
		bank5[i] = 0x38
	}
	// Layer 2: bank 1, classic 256x192 (NR$70 resolution 0), rows 0..63
	// filled with palette index 2.
	l2bank := mem.GetPage(1)
	for i := 0; i < 0x4000; i++ {
		l2bank[i] = 2
	}
	writeReg(0x12, 1)
	writeReg(0x70, 0x00)
	writeReg(0x69, 0x80) // Layer 2 enable
	// Copper upload + StartOnVBL.
	writeReg(0x61, 0)
	writeReg(0x62, 0)
	for _, w := range program {
		writeReg(0x60, byte(w>>8))
		writeReg(0x60, byte(w))
	}
	writeReg(0x61, 0)
	writeReg(0x62, 0xC0) // mode 11: restart from 0 every VBL
	h.RunFrames(4)
	return h
}

// halfAtPaper reads OUTPUT half-pixel hx of paper row y from the
// 640-wide frame (paper left edge at output column 64).
func halfAtPaper(h *Harness, hx, y int) [3]byte {
	return imgRGB(h.ScreenImage(), 64+hx, 32+y)
}

var (
	liveL2Blue   = [3]byte{0, 0, 182}     // identity palette entry 2 ($005)
	liveL2Red    = [3]byte{255, 0, 0}     // entry 2 rewritten to $1C0
	liveULAWhite = [3]byte{182, 182, 182} // classic white paper via the ULA palette
)

// TestCopperMidRowNR15FlipHalfPixel — §4.3: a copper MOVE to NR$15
// flips the LAYER ORDER at its landing half-pixel. WAIT(40, X=4)
// releases at hcount (4<<3)+12 = 44 — display pixel 32 — and the MOVE
// switching SLU (L2 over ULA: blue) to SUL (ULA over L2: white) is
// visible from that pixel's EVEN half (output half 64). A second
// WAIT/MOVE restores SLU at the start of row 48.
func TestCopperMidRowNR15FlipHalfPixel(t *testing.T) {
	h := newHalfPixelLiveHarness(t, []uint16{
		0x8000 | 4<<9 | 40, // WAIT line 40, X=4
		0x1508,             // MOVE NR$15, $08 (mode SUL)
		0x8000 | 0<<9 | 48, // WAIT line 48, X=0
		0x1500,             // MOVE NR$15, $00 (mode SLU)
		0xFFFF,             // HALT
	})
	// Row 39 (before the flip): SLU everywhere — Layer 2 blue.
	for _, hx := range []int{0, 64, 300, 511} {
		if got := halfAtPaper(h, hx, 39); got != liveL2Blue {
			t.Errorf("row 39 half %d = %v, want L2 blue (SLU)", hx, got)
		}
	}
	// Row 40: the flip lands on half 64 exactly.
	for hx, want := range map[int][3]byte{62: liveL2Blue, 63: liveL2Blue, 64: liveULAWhite, 65: liveULAWhite, 300: liveULAWhite} {
		if got := halfAtPaper(h, hx, 40); got != want {
			t.Errorf("row 40 half %d = %v, want %v (NR$15 flip at the landing half-pixel)", hx, got, want)
		}
	}
	// Rows fully inside the SUL band: ULA white everywhere.
	for _, hx := range []int{0, 200, 511} {
		if got := halfAtPaper(h, hx, 44); got != liveULAWhite {
			t.Errorf("row 44 half %d = %v, want ULA white (SUL band)", hx, got)
		}
	}
	// Row 48 restores SLU from its very first pixel (X=0 releases at
	// hcount 12 = pixel 0).
	for _, hx := range []int{0, 200, 511} {
		if got := halfAtPaper(h, hx, 48); got != liveL2Blue {
			t.Errorf("row 48 half %d = %v, want L2 blue (SLU restored)", hx, got)
		}
	}
}

// TestCopperMidRowPaletteMoveRecoloursLayer2 — §4.4: a copper palette
// MOVE recolours LAYER 2 pixels from its landing half-pixel — the
// two-BRAM multiplex resolves L2 through the palette once per
// half-pixel (zxnext.vhd:7033) and a write is visible on the next
// lookup (:6969-6977). After WAIT(40, X=4) releases (pixel 32), MOVE
// NR$40,2 lands on the even half and the recolouring MOVE NR$41,$E0
// one half-pixel later — red from output half 65. Row 48 restores the
// identity value ($02 -> 9-bit $005, byte-identical to the boot
// entry).
func TestCopperMidRowPaletteMoveRecoloursLayer2(t *testing.T) {
	h := newHalfPixelLiveHarness(t, nil)
	// Select the Layer 2 first palette as the write target BEFORE
	// uploading the program (the copper writes only NR$40/$41).
	h.ULA().WritePort(0x243B, 0x43)
	h.ULA().WritePort(0x253B, 1<<4)
	writeReg := func(reg, val byte) {
		h.ULA().WritePort(0x243B, reg)
		h.ULA().WritePort(0x253B, val)
	}
	writeReg(0x62, 0) // stop + cursor high 0 (mode transition from $C0)
	writeReg(0x61, 0)
	for _, w := range []uint16{
		0x8000 | 4<<9 | 40, // WAIT line 40, X=4
		0x4002,             // MOVE NR$40, 2 (palette index)
		0x41E0,             // MOVE NR$41, $E0 (9-bit $1C0: red)
		0x8000 | 0<<9 | 48, // WAIT line 48, X=0
		0x4002,             // MOVE NR$40, 2
		0x4102,             // MOVE NR$41, $02 (9-bit $005: the boot identity)
		0xFFFF,             // HALT
	} {
		writeReg(0x60, byte(w>>8))
		writeReg(0x60, byte(w))
	}
	writeReg(0x61, 0)
	writeReg(0x62, 0xC0)
	h.RunFrames(4)

	// Row 39: untouched palette — blue.
	if got := halfAtPaper(h, 300, 39); got != liveL2Blue {
		t.Errorf("row 39 = %v, want L2 blue", got)
	}
	// Row 40: MOVE NR$41 lands one half-pixel after the index MOVE —
	// red from output half 65.
	for hx, want := range map[int][3]byte{63: liveL2Blue, 64: liveL2Blue, 65: liveL2Red, 66: liveL2Red, 300: liveL2Red} {
		if got := halfAtPaper(h, hx, 40); got != want {
			t.Errorf("row 40 half %d = %v, want %v (palette MOVE lands per half-pixel)", hx, got, want)
		}
	}
	// Row 44: fully red. Row 48: the restore's WAIT(48, X=0) releases
	// at pixel 0's even half, so the index MOVE lands there and the
	// VALUE MOVE one half-pixel later — half 0 still shows red, blue
	// from half 1 onward. The same one-MOVE-per-half-pixel cadence as
	// the recolour above, pinned on the restore edge too.
	if got := halfAtPaper(h, 200, 44); got != liveL2Red {
		t.Errorf("row 44 = %v, want red", got)
	}
	if got := halfAtPaper(h, 0, 48); got != liveL2Red {
		t.Errorf("row 48 half 0 = %v, want red (value MOVE lands one half in)", got)
	}
	for _, hx := range []int{1, 200, 511} {
		if got := halfAtPaper(h, hx, 48); got != liveL2Blue {
			t.Errorf("row 48 half %d = %v, want blue (restore)", hx, got)
		}
	}
}
